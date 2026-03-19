/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * STRICT ISOLATION: Every request is routed exclusively to the requesting
 * user's runner. No cross-user fallbacks. If the user has no runner
 * registered, return null → 502.
 *
 * The resolver only handles USER-SCOPING (who owns the runner).
 * It does NOT check WebSocket connectivity — that's the tunnel's job.
 * The tunnel fails instantly if the WS is down, so there's no delay.
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
import { getRunnerForThread } from './thread-registry.js';

export interface ResolvedRunner {
  runnerId: string;
  /** Null if the runner has no direct HTTP URL (behind NAT — use tunnel) */
  httpUrl: string | null;
}

// In-memory cache: threadId → { runnerId, httpUrl }
const threadRunnerCache = new Map<string, ResolvedRunner>();

/**
 * Resolve which runner should handle a request.
 * Returns { runnerId, httpUrl } or null if no runner is registered for this user.
 *
 * All resolution paths are scoped to the requesting user's runners.
 * WebSocket connectivity is NOT checked here — the tunnel handles that.
 */
export async function resolveRunner(
  path: string,
  query: Record<string, string>,
  userId?: string,
): Promise<ResolvedRunner | null> {
  const projectId = extractProjectId(path, query);
  const threadId = extractThreadId(path);

  // Strategy 1: Thread cache
  if (threadId) {
    const cached = threadRunnerCache.get(threadId);
    if (cached) return cached;
  }

  // Strategy 2: Project assignment (scoped to userId)
  if (projectId && userId) {
    const resolved = await resolveByProject(projectId, userId);
    if (resolved) return resolved;
  }

  // Strategy 3: Thread registry DB lookup (scoped to userId)
  if (threadId && userId) {
    const fromDb = await getRunnerForThread(threadId, userId);
    if (fromDb) {
      const resolved: ResolvedRunner = {
        runnerId: fromDb.runnerId,
        httpUrl: fromDb.httpUrl ?? null,
      };
      threadRunnerCache.set(threadId, resolved);
      return resolved;
    }
  }

  // Strategy 4: User's runner (last resort, still user-scoped)
  if (userId) {
    return await resolveUserRunner(userId);
  }

  return null;
}

/**
 * Cache a thread → runner mapping (called when threads are created).
 */
export function cacheThreadRunner(
  threadId: string,
  runnerId: string,
  httpUrl: string | null,
): void {
  threadRunnerCache.set(threadId, { runnerId, httpUrl });
}

/**
 * Remove a thread from the cache (called when threads are deleted).
 */
export function uncacheThread(threadId: string): void {
  threadRunnerCache.delete(threadId);
}

/**
 * Evict all cache entries for a specific runner (called when runner disconnects).
 */
export function evictRunnerFromCache(runnerId: string): void {
  for (const [threadId, resolved] of threadRunnerCache) {
    if (resolved.runnerId === runnerId) {
      threadRunnerCache.delete(threadId);
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
 * Find the user's runner (DB lookup only, no WS check).
 * Returns the first runner belonging to this user, or null.
 */
async function resolveUserRunner(userId: string): Promise<ResolvedRunner | null> {
  const userRunners = await db
    .select({ id: runners.id, httpUrl: runners.httpUrl })
    .from(runners)
    .where(eq(runners.userId, userId))
    .limit(1);

  if (userRunners.length === 0) return null;

  return { runnerId: userRunners[0].id, httpUrl: userRunners[0].httpUrl ?? null };
}

/**
 * Resolve runner for a project, scoped to the requesting user.
 * DB lookup only — no WS connectivity check.
 */
async function resolveByProject(projectId: string, userId: string): Promise<ResolvedRunner | null> {
  const assignments = await db
    .select({
      runnerId: runnerProjectAssignments.runnerId,
      httpUrl: runners.httpUrl,
    })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(and(eq(runnerProjectAssignments.projectId, projectId), eq(runners.userId, userId)))
    .limit(1);

  if (assignments.length === 0 || !assignments[0].runnerId) return null;

  return { runnerId: assignments[0].runnerId, httpUrl: assignments[0].httpUrl ?? null };
}
