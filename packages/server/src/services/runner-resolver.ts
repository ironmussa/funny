/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * STRICT ISOLATION: Every request is routed exclusively to the requesting
 * user's runner. No cross-user fallbacks. If the user has no runner
 * reachable, return null → 502.
 *
 * PROJECT ISOLATION (project-runner-binding, see runner-scope.ts):
 *   - A project pinned to a dedicated runner routes ONLY to that runner (plus
 *     explicit grants). If none is reachable → null, never a fallback.
 *   - Any other project routes to one of the user's GENERAL runners that the
 *     scope rule allows (thread's runner → runner holding the checkout →
 *     designated general runner → other general runners).
 *   - Projectless work (scratch threads, browse, settings, system) routes ONLY
 *     to the user's general runners.
 *
 * A runner is considered reachable only while it has an active gRPC session.
 */

import { and, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { runnerProjectAssignments, runners, threads } from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { RunnerPresencePort } from './runner-ports.js';
import {
  canRunnerAccessProject,
  canRunnerServeProjectless,
  generalRunnerIdsForUser,
  onRunnerScopeChange,
  pinnedRunnerIdsForProject,
} from './runner-scope.js';
import { getRunnerForThread } from './thread-registry.js';

export interface ResolvedRunner {
  runnerId: string;
}

/** Why a request could not be routed (drives the 502 message). */
export type RunnerResolutionFailure = 'project-runner-offline' | 'general-runner-offline';

type CachedThreadRunner = ResolvedRunner & { threadId: string; userId: string };

// In-memory cache scoped by userId + threadId. A thread id alone is not a
// sufficient authorization boundary because cache hits bypass DB ownership
// checks for speed.
const threadRunnerCache = new Map<string, CachedThreadRunner>();

// Any change to runner roles / project pins / grants can invalidate a cached
// route — drop them all (cheap: the cache only saves one DB round-trip).
onRunnerScopeChange(() => threadRunnerCache.clear());

function threadCacheKey(userId: string, threadId: string): string {
  return `${userId}:${threadId}`;
}

function isReachable(presence: RunnerPresencePort | undefined, runnerId: string): boolean {
  return !!presence?.isAvailable(runnerId);
}

/** Where a request points: a project, or projectless work. */
type RouteTarget = { kind: 'project'; projectId: string } | { kind: 'projectless' };

async function resolveTarget(
  projectId: string | null,
  threadId: string | null,
): Promise<RouteTarget> {
  if (projectId) return { kind: 'project', projectId };
  if (threadId) {
    const [row] = await db
      .select({ projectId: threads.projectId })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (row?.projectId) return { kind: 'project', projectId: row.projectId };
  }
  return { kind: 'projectless' };
}

async function isAllowed(runnerId: string, target: RouteTarget): Promise<boolean> {
  return target.kind === 'project'
    ? canRunnerAccessProject(runnerId, target.projectId)
    : canRunnerServeProjectless(runnerId);
}

/**
 * Resolve which runner should handle a request.
 * Returns the runner identity or null if no runner is reachable for this user.
 */
export async function resolveRunner(
  path: string,
  query: Record<string, string>,
  userId?: string,
  presence?: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const resolved = await resolveRunnerDetailed(path, query, userId, presence);
  return resolved.ok ? { runnerId: resolved.runnerId } : null;
}

export async function resolveRunnerDetailed(
  path: string,
  query: Record<string, string>,
  userId?: string,
  presence?: RunnerPresencePort,
): Promise<
  | { ok: true; runnerId: string }
  | { ok: false; reason: RunnerResolutionFailure; projectId?: string }
> {
  const threadId = extractThreadId(path);
  if (!userId) return { ok: false, reason: 'general-runner-offline' };

  // Thread cache (entries are dropped on any scope change; verify reachability)
  if (threadId) {
    const cached = threadRunnerCache.get(threadCacheKey(userId, threadId));
    if (cached) {
      if (isReachable(presence, cached.runnerId)) return { ok: true, runnerId: cached.runnerId };
      threadRunnerCache.delete(threadCacheKey(userId, threadId));
    }
  }

  const target = await resolveTarget(extractProjectId(path, query), threadId);
  const remember = (runnerId: string) => {
    if (threadId) {
      threadRunnerCache.set(threadCacheKey(userId, threadId), {
        runnerId,
        threadId,
        userId,
      });
    }
    return { ok: true as const, runnerId };
  };

  // Pinned project: its dedicated runner (+ grants) or nothing.
  if (target.kind === 'project') {
    const pinned = await pinnedRunnerIdsForProject(target.projectId, userId);
    if (pinned) {
      const runnerId = pinned.find((id) => isReachable(presence, id));
      if (runnerId) return remember(runnerId);
      log.warn('Project runner offline — not falling back', {
        namespace: 'proxy',
        userId,
        projectId: target.projectId,
        path,
      });
      return {
        ok: false,
        reason: 'project-runner-offline',
        projectId: target.projectId,
      };
    }
  }

  // Ordered candidates, all owned by the user; filtered by reachability + scope.
  const candidates: string[] = [];
  if (threadId) {
    const fromDb = await getRunnerForThread(threadId, userId);
    if (fromDb) candidates.push(fromDb.runnerId);
  }
  if (target.kind === 'project') {
    candidates.push(...(await assignedRunnerIds(target.projectId, userId)));
  }
  candidates.push(...(await generalRunnerIdsForUser(userId)));

  for (const runnerId of new Set(candidates)) {
    if (!isReachable(presence, runnerId)) continue;
    if (!(await isAllowed(runnerId, target))) continue;
    return remember(runnerId);
  }

  log.warn('No reachable runner found', {
    namespace: 'proxy',
    requestUserId: userId,
    threadId: threadId ?? 'none',
    projectId: target.kind === 'project' ? target.projectId : 'none',
    path,
  });
  return {
    ok: false,
    reason: 'general-runner-offline',
    projectId: target.kind === 'project' ? target.projectId : undefined,
  };
}

/**
 * Explain why `resolveRunner` returned null for a request (failure path only):
 * a pinned project whose runner is offline gets its own actionable message.
 */
export async function explainUnresolved(
  path: string,
  query: Record<string, string>,
  userId?: string,
): Promise<RunnerResolutionFailure> {
  if (!userId) return 'general-runner-offline';
  const target = await resolveTarget(extractProjectId(path, query), extractThreadId(path));
  if (target.kind === 'project' && (await pinnedRunnerIdsForProject(target.projectId, userId))) {
    return 'project-runner-offline';
  }
  return 'general-runner-offline';
}

/** User-facing 502 message for a routing failure. */
export function describeResolutionFailure(reason: RunnerResolutionFailure): {
  error: string;
  code: RunnerResolutionFailure;
} {
  return reason === 'project-runner-offline'
    ? {
        error: "This project's runner is offline. Start or redeploy it from Project Settings.",
        code: reason,
      }
    : {
        error: 'No runner connected. Check that your runner is online.',
        code: reason,
      };
}

/**
 * Cache a thread → runner mapping (called when threads are created).
 */
export function cacheThreadRunner(threadId: string, userId: string, runnerId: string): void {
  threadRunnerCache.set(threadCacheKey(userId, threadId), {
    threadId,
    userId,
    runnerId,
  });
}

/**
 * Remove a thread from the cache (called when threads are deleted).
 */
export function uncacheThread(threadId: string): void {
  for (const [key, resolved] of threadRunnerCache) {
    if (resolved.threadId === threadId) {
      threadRunnerCache.delete(key);
    }
  }
}

/**
 * Evict all cache entries for a specific runner (called when runner disconnects).
 */
export function evictRunnerFromCache(runnerId: string): void {
  for (const [key, resolved] of threadRunnerCache) {
    if (resolved.runnerId === runnerId) {
      threadRunnerCache.delete(key);
    }
  }
}

// ── Internal helpers ──────────────────────────────────────

function extractProjectId(path: string, query: Record<string, string>): string | null {
  const gitProjectMatch = path.match(/\/api\/git\/project\/([^/]+)/);
  if (gitProjectMatch) return gitProjectMatch[1];

  const projectMatch = path.match(/\/api\/projects\/([^/]+)/);
  if (projectMatch) return projectMatch[1];

  const testsMatch = path.match(/\/api\/tests\/([^/]+)/);
  if (testsMatch) return testsMatch[1];

  if (query.projectId) return query.projectId;

  return null;
}

function extractThreadId(path: string): string | null {
  const threadMatch = path.match(/\/api\/threads\/([^/?]+)/);
  if (threadMatch) return threadMatch[1];

  const gitMatch = path.match(/\/api\/git\/([^/]+)/);
  if (gitMatch && gitMatch[1] !== 'project' && gitMatch[1] !== 'status') {
    return gitMatch[1];
  }

  return null;
}

/**
 * Find any reachable GENERAL runner, regardless of user.
 * Used for unauthenticated callbacks (e.g., MCP OAuth redirect from external provider).
 * The runtime itself validates the request (e.g., via state parameter).
 * Dedicated runners are never eligible: they must only ever see their own
 * project's traffic (project-runner-binding).
 */
export async function resolveAnyRunner(
  presence?: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const allRunners = await db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.role, 'general'));

  for (const r of allRunners) {
    if (presence?.isAvailable(r.id)) {
      return { runnerId: r.id };
    }
  }
  return null;
}

/**
 * The user's runners holding a checkout of the project (location records).
 * Preference only — access is still decided by runner-scope.
 */
async function assignedRunnerIds(projectId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ runnerId: runnerProjectAssignments.runnerId })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(and(eq(runnerProjectAssignments.projectId, projectId), eq(runners.userId, userId)));
  return rows.map((r) => r.runnerId);
}
