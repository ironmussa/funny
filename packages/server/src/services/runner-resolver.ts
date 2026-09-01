/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * STRICT ISOLATION: Every request is routed exclusively to the requesting
 * user's runner. No cross-user fallbacks. If the user has no runner
 * reachable, return null → 502.
 *
 * A runner is considered reachable only while it has an active gRPC session.
 *
 * Resolution strategies:
 * 1. Thread cache (in-memory)
 * 2. Project assignment (DB, scoped to userId)
 * 3. Thread registry (DB, scoped to userId)
 * 4. User's runner (any runner belonging to this user)
 */

import { and, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { runnerProjectAssignments, runners } from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { RunnerPresencePort } from './runner-ports.js';
import { getRunnerForThread } from './thread-registry.js';

export interface ResolvedRunner {
  runnerId: string;
}

type CachedThreadRunner = ResolvedRunner & { threadId: string; userId: string };

// In-memory cache scoped by userId + threadId. A thread id alone is not a
// sufficient authorization boundary because cache hits bypass DB ownership
// checks for speed.
const threadRunnerCache = new Map<string, CachedThreadRunner>();

function threadCacheKey(userId: string, threadId: string): string {
  return `${userId}:${threadId}`;
}

function isReachable(presence: RunnerPresencePort, runnerId: string): boolean {
  return presence.isAvailable(runnerId);
}

/**
 * Resolve which runner should handle a request.
 * Returns the runner identity or null if no runner is reachable for this user.
 *
 * All resolution paths are scoped to the requesting user's runners.
 * Runners must have an active gRPC session.
 */
export async function resolveRunner(
  path: string,
  query: Record<string, string>,
  userId?: string,
  presence?: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const projectId = extractProjectId(path, query);
  const threadId = extractThreadId(path);

  // Strategy 1: Thread cache (verify runner is still reachable)
  if (threadId && userId) {
    const cached = threadRunnerCache.get(threadCacheKey(userId, threadId));
    if (cached) {
      if (presence?.isAvailable(cached.runnerId)) {
        return { runnerId: cached.runnerId };
      }
      // Stale cache entry — runner unreachable, evict it
      threadRunnerCache.delete(threadCacheKey(userId, threadId));
    }
  }

  // Strategy 2: Project assignment (scoped to userId)
  if (projectId && userId) {
    const resolved = presence ? await resolveByProject(projectId, userId, presence) : null;
    if (resolved) return resolved;
  }

  // Strategy 3: Thread registry DB lookup (scoped to userId)
  if (threadId && userId) {
    const fromDb = await getRunnerForThread(threadId, userId);
    if (fromDb) {
      if (presence?.isAvailable(fromDb.runnerId)) {
        const resolved: ResolvedRunner = { runnerId: fromDb.runnerId };
        threadRunnerCache.set(threadCacheKey(userId, threadId), { ...resolved, threadId, userId });
        return resolved;
      }
    }
  }

  // Strategy 4: User's runner (last resort, still user-scoped)
  if (userId) {
    const resolved = presence ? await resolveUserRunner(userId, presence) : null;
    if (resolved) return resolved;
  }

  // Diagnostic: log all runners in DB to identify userId mismatches
  const allRunners = await db.select({ id: runners.id, userId: runners.userId }).from(runners);
  log.warn('No reachable runner found', {
    namespace: 'proxy',
    requestUserId: userId ?? 'none',
    threadId: threadId ?? 'none',
    projectId: projectId ?? 'none',
    path,
    runnersInDb: allRunners.map((r) => ({
      id: r.id,
      userId: r.userId ?? 'null',
      connected: presence?.isAvailable(r.id) ?? false,
    })),
  });

  return null;
}

/**
 * Cache a thread → runner mapping (called when threads are created).
 */
export function cacheThreadRunner(threadId: string, userId: string, runnerId: string): void {
  threadRunnerCache.set(threadCacheKey(userId, threadId), { threadId, userId, runnerId });
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
 * Find any reachable runner, regardless of user.
 * Used for unauthenticated callbacks (e.g., MCP OAuth redirect from external provider).
 * The runtime itself validates the request (e.g., via state parameter).
 */
export async function resolveAnyRunner(
  presence?: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const allRunners = await db.select({ id: runners.id }).from(runners);

  for (const r of allRunners) {
    if (presence?.isAvailable(r.id)) {
      return { runnerId: r.id };
    }
  }
  return null;
}

/**
 * Find a reachable runner belonging to this user.
 * Requires an active gRPC session.
 */
async function resolveUserRunner(
  userId: string,
  presence: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const userRunners = await db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, userId));

  for (const r of userRunners) {
    if (isReachable(presence, r.id)) {
      return { runnerId: r.id };
    }
  }

  return null;
}

/**
 * Resolve runner for a project, scoped to the requesting user.
 * Only returns runners with active gRPC sessions.
 */
async function resolveByProject(
  projectId: string,
  userId: string,
  presence: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  const assignments = await db
    .select({
      runnerId: runnerProjectAssignments.runnerId,
    })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(and(eq(runnerProjectAssignments.projectId, projectId), eq(runners.userId, userId)));

  for (const a of assignments) {
    if (a.runnerId && isReachable(presence, a.runnerId)) {
      return { runnerId: a.runnerId };
    }
  }

  return null;
}
