/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * STRICT ISOLATION: Every request is routed exclusively to the requesting
 * user's runner. No cross-user fallbacks. If the user has no runner
 * reachable, return null → 502.
 *
 * A runner is considered "reachable" if it has an active WebSocket tunnel
 * OR a direct HTTP URL. The proxy tries tunnel first, then httpUrl fallback.
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
import { isPolling } from './http-tunnel.js';
import { getRunnerForThread } from './thread-registry.js';
import { isRunnerConnected } from './ws-relay.js';

export interface ResolvedRunner {
  runnerId: string;
  /** Null if the runner has no direct HTTP URL (behind NAT — use tunnel) */
  httpUrl: string | null;
}

// In-memory cache: threadId → { runnerId, httpUrl }
const threadRunnerCache = new Map<string, ResolvedRunner>();

/**
 * A runner is reachable if it has a live WebSocket OR a direct HTTP URL.
 * Set WS_ONLY=true to disable httpUrl fallback (for testing WS stability).
 */
const WS_ONLY = !!process.env.WS_TUNNEL_ONLY;

function isReachable(runnerId: string, httpUrl: string | null): boolean {
  if (WS_ONLY) return isRunnerConnected(runnerId) || isPolling(runnerId);
  return isRunnerConnected(runnerId) || isPolling(runnerId) || !!httpUrl;
}

/**
 * Resolve which runner should handle a request.
 * Returns { runnerId, httpUrl } or null if no runner is reachable for this user.
 *
 * All resolution paths are scoped to the requesting user's runners.
 * Runners must be reachable (WS connected or httpUrl available).
 */
export async function resolveRunner(
  path: string,
  query: Record<string, string>,
  userId?: string,
): Promise<ResolvedRunner | null> {
  const projectId = extractProjectId(path, query);
  const threadId = extractThreadId(path);

  // Strategy 1: Thread cache (verify runner is still reachable)
  if (threadId) {
    const cached = threadRunnerCache.get(threadId);
    if (cached) {
      if (isReachable(cached.runnerId, cached.httpUrl)) return cached;
      // Stale cache entry — runner unreachable, evict it
      threadRunnerCache.delete(threadId);
    }
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
      const httpUrl = fromDb.httpUrl ?? null;
      if (isReachable(fromDb.runnerId, httpUrl)) {
        const resolved: ResolvedRunner = {
          runnerId: fromDb.runnerId,
          httpUrl,
        };
        threadRunnerCache.set(threadId, resolved);
        return resolved;
      }
    }
  }

  // Strategy 4: User's runner (last resort, still user-scoped)
  if (userId) {
    const resolved = await resolveUserRunner(userId);
    if (resolved) return resolved;
  }

  // Diagnostic: log all runners in DB to identify userId mismatches
  const allRunners = await db
    .select({ id: runners.id, userId: runners.userId, httpUrl: runners.httpUrl })
    .from(runners);
  log.warn('No reachable runner found', {
    namespace: 'proxy',
    requestUserId: userId ?? 'none',
    threadId: threadId ?? 'none',
    projectId: projectId ?? 'none',
    path,
    runnersInDb: allRunners.map((r) => ({
      id: r.id,
      userId: r.userId ?? 'null',
      wsConnected: isRunnerConnected(r.id),
      polling: isPolling(r.id),
      hasHttpUrl: !!r.httpUrl,
    })),
  });

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
 * Find a reachable runner belonging to this user.
 * Prefers WS-connected runners, falls back to httpUrl-only runners.
 */
async function resolveUserRunner(userId: string): Promise<ResolvedRunner | null> {
  const userRunners = await db
    .select({ id: runners.id, httpUrl: runners.httpUrl })
    .from(runners)
    .where(eq(runners.userId, userId));

  // First pass: prefer WS-connected or actively polling runners
  for (const r of userRunners) {
    if (isRunnerConnected(r.id) || isPolling(r.id)) {
      return { runnerId: r.id, httpUrl: r.httpUrl ?? null };
    }
  }

  // Second pass: accept runners with httpUrl (direct HTTP fallback)
  if (!WS_ONLY) {
    for (const r of userRunners) {
      if (r.httpUrl) {
        return { runnerId: r.id, httpUrl: r.httpUrl };
      }
    }
  }

  return null;
}

/**
 * Resolve runner for a project, scoped to the requesting user.
 * Only returns reachable runners (WS connected or httpUrl available).
 */
async function resolveByProject(projectId: string, userId: string): Promise<ResolvedRunner | null> {
  const assignments = await db
    .select({
      runnerId: runnerProjectAssignments.runnerId,
      httpUrl: runners.httpUrl,
    })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(and(eq(runnerProjectAssignments.projectId, projectId), eq(runners.userId, userId)));

  // Prefer WS-connected or actively polling, fall back to httpUrl
  for (const a of assignments) {
    if (a.runnerId && (isRunnerConnected(a.runnerId) || isPolling(a.runnerId))) {
      return { runnerId: a.runnerId, httpUrl: a.httpUrl ?? null };
    }
  }
  if (!WS_ONLY) {
    for (const a of assignments) {
      if (a.runnerId && a.httpUrl) {
        return { runnerId: a.runnerId, httpUrl: a.httpUrl };
      }
    }
  }

  return null;
}
