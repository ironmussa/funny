/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * Resolution strategies:
 * 1. Extract projectId from URL params or query → look up runner via project assignments
 * 2. Extract threadId from URL params → look up runner via thread registry (Phase 3)
 * 3. Fall back to null if no runner can be determined
 */

import { and, eq, ne } from 'drizzle-orm';

import { db } from '../db/index.js';
import { runnerProjectAssignments, runners } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { getRunnerForThread } from './thread-registry.js';

export interface ResolvedRunner {
  runnerId: string;
  /** Null if the runner has no direct HTTP URL (behind NAT — use tunnel) */
  httpUrl: string | null;
}

// In-memory cache: threadId → { runnerId, httpUrl }
const threadRunnerCache = new Map<string, ResolvedRunner>();

// Fallback: if a default runner URL is configured, use it when no runner is registered
const DEFAULT_RUNNER_URL = process.env.DEFAULT_RUNNER_URL || null;

/**
 * Resolve which runner should handle a request.
 * Returns { runnerId, httpUrl } where httpUrl may be null (use tunnel).
 * Returns null if no runner can be determined.
 *
 * When userId is provided, resolution is scoped to that user's runners
 * to ensure tenant isolation.
 */
export async function resolveRunner(
  path: string,
  query: Record<string, string>,
  userId?: string,
): Promise<ResolvedRunner | null> {
  const projectId = extractProjectId(path, query);
  const threadId = extractThreadId(path);

  // Strategy 1: Thread-based resolution (cached from thread creation)
  if (threadId) {
    const cached = threadRunnerCache.get(threadId);
    if (cached) return cached;
  }

  // Strategy 2: Project-based resolution
  if (projectId) {
    const resolved = await resolveByProject(projectId, userId);
    if (resolved) return resolved;
  }

  // Strategy 3: Thread registry DB lookup (fallback when cache misses)
  if (threadId) {
    const fromDb = await getRunnerForThread(threadId);
    if (fromDb) {
      const resolved: ResolvedRunner = {
        runnerId: fromDb.runnerId,
        httpUrl: fromDb.httpUrl ?? null,
      };
      threadRunnerCache.set(threadId, resolved);
      return resolved;
    }
    log.warn('No runner found for thread', { namespace: 'proxy', threadId });
  }

  // Strategy 4: Fallback to any online runner scoped to this user (or DEFAULT_RUNNER_URL)
  return await resolveAnyOnlineRunner(userId);
}

/**
 * @deprecated Use resolveRunner() instead. Kept for backward compatibility during migration.
 */
export async function resolveRunnerUrl(
  path: string,
  query: Record<string, string>,
): Promise<string | null> {
  const resolved = await resolveRunner(path, query);
  return resolved?.httpUrl ?? null;
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

// ── Internal helpers ──────────────────────────────────────

/**
 * Extract projectId from URL path or query params.
 */
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

/**
 * Extract threadId from URL path.
 */
function extractThreadId(path: string): string | null {
  const threadMatch = path.match(/\/api\/threads\/([^/?]+)/);
  if (threadMatch) return threadMatch[1];

  const gitMatch = path.match(/\/api\/git\/([^/]+)/);
  if (gitMatch && gitMatch[1] !== 'project' && gitMatch[1] !== 'status') {
    return gitMatch[1];
  }

  return null;
}

async function resolveAnyOnlineRunner(userId?: string): Promise<ResolvedRunner | null> {
  // First try user-scoped runners
  if (userId) {
    const userRunners = await db
      .select({ id: runners.id, httpUrl: runners.httpUrl })
      .from(runners)
      .where(and(ne(runners.status, 'offline'), eq(runners.userId, userId)));

    if (userRunners.length > 0) {
      return { runnerId: userRunners[0].id, httpUrl: userRunners[0].httpUrl ?? null };
    }
  }

  // Fallback: any online runner (includes runners registered without a userId, e.g. dev mode
  // runners that authenticated via shared secret without an invite token)
  const allOnline = await db
    .select({ id: runners.id, httpUrl: runners.httpUrl })
    .from(runners)
    .where(ne(runners.status, 'offline'));

  if (allOnline.length > 0) {
    return { runnerId: allOnline[0].id, httpUrl: allOnline[0].httpUrl ?? null };
  }

  // Fallback to configured default runner URL
  if (DEFAULT_RUNNER_URL) {
    log.debug('Using DEFAULT_RUNNER_URL fallback', { namespace: 'proxy', url: DEFAULT_RUNNER_URL });
    return { runnerId: '__default__', httpUrl: DEFAULT_RUNNER_URL };
  }

  return null;
}

async function resolveByProject(
  projectId: string,
  userId?: string,
): Promise<ResolvedRunner | null> {
  const condition = userId
    ? and(eq(runnerProjectAssignments.projectId, projectId), eq(runners.userId, userId))
    : eq(runnerProjectAssignments.projectId, projectId);

  const assignments = await db
    .select({
      runnerId: runnerProjectAssignments.runnerId,
      httpUrl: runners.httpUrl,
      status: runners.status,
    })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(condition);

  // Filter to online runners
  const online = assignments.filter((a) => a.status !== 'offline');
  if (online.length === 0) {
    log.warn('No online runner found for project', { namespace: 'proxy', projectId });
    return null;
  }

  return { runnerId: online[0].runnerId, httpUrl: online[0].httpUrl ?? null };
}
