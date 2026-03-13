/**
 * Runner resolver for the central server.
 * Given an incoming HTTP request, determines which runner should handle it.
 *
 * Resolution strategies:
 * 1. Extract projectId from URL params or query → look up runner via project assignments
 * 2. Extract threadId from URL params → look up runner via thread registry (Phase 3)
 * 3. Fall back to null if no runner can be determined
 */

import { eq, ne } from 'drizzle-orm';

import { db } from '../db/index.js';
import { runnerProjectAssignments, runners } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { getRunnerForThread } from './thread-registry.js';

// In-memory cache: threadId → { runnerId, httpUrl }
const threadRunnerCache = new Map<string, { runnerId: string; httpUrl: string }>();

// Fallback: if a default runner URL is configured, use it when no runner is registered
const DEFAULT_RUNNER_URL = process.env.DEFAULT_RUNNER_URL || null;

/**
 * Resolve which runner should handle a request, returning its httpUrl.
 * Returns null if no runner can be determined.
 */
export async function resolveRunnerUrl(
  path: string,
  query: Record<string, string>,
): Promise<string | null> {
  // Try to extract projectId or threadId from the path
  const projectId = extractProjectId(path, query);
  const threadId = extractThreadId(path);

  // Strategy 1: Thread-based resolution (cached from thread creation)
  if (threadId) {
    const cached = threadRunnerCache.get(threadId);
    if (cached) return cached.httpUrl;
  }

  // Strategy 2: Project-based resolution
  if (projectId) {
    const url = await resolveByProject(projectId);
    if (url) return url;
  }

  // Strategy 3: Thread registry DB lookup (fallback when cache misses)
  if (threadId) {
    const fromDb = await getRunnerForThread(threadId);
    if (fromDb) {
      // Populate the cache for next time
      threadRunnerCache.set(threadId, fromDb);
      return fromDb.httpUrl;
    }
    log.warn('No runner found for thread', { namespace: 'proxy', threadId });
  }

  // Strategy 4: Fallback to any online runner (or DEFAULT_RUNNER_URL)
  // In a typical deployment there is a single Runtime instance. This ensures
  // all routes can reach it even without project/thread-specific assignments.
  return await resolveAnyOnlineRunner();
}

/**
 * Cache a thread → runner mapping (called when threads are created).
 */
export function cacheThreadRunner(threadId: string, runnerId: string, httpUrl: string): void {
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
 *
 * Matches patterns like:
 * - /api/git/project/:projectId/...
 * - /api/threads?projectId=xxx
 * - /api/projects/:projectId/branches
 */
function extractProjectId(path: string, query: Record<string, string>): string | null {
  // /api/git/project/:projectId/...
  const gitProjectMatch = path.match(/\/api\/git\/project\/([^/]+)/);
  if (gitProjectMatch) return gitProjectMatch[1];

  // /api/projects/:projectId/... (but not /api/projects itself)
  const projectMatch = path.match(/\/api\/projects\/([^/]+)/);
  if (projectMatch) return projectMatch[1];

  // Query param: ?projectId=xxx
  if (query.projectId) return query.projectId;

  return null;
}

/**
 * Extract threadId from URL path.
 *
 * Matches patterns like:
 * - /api/threads/:threadId
 * - /api/threads/:threadId/...
 * - /api/git/:threadId/...  (where threadId is NOT "project")
 */
function extractThreadId(path: string): string | null {
  // /api/threads/:threadId/... (but not /api/threads itself or /api/threads?...)
  const threadMatch = path.match(/\/api\/threads\/([^/?]+)/);
  if (threadMatch) return threadMatch[1];

  // /api/git/:threadId/... (when it's not /api/git/project/...)
  const gitMatch = path.match(/\/api\/git\/([^/]+)/);
  if (gitMatch && gitMatch[1] !== 'project' && gitMatch[1] !== 'status') {
    return gitMatch[1];
  }

  return null;
}

async function resolveAnyOnlineRunner(): Promise<string | null> {
  const onlineRunners = await db
    .select({ httpUrl: runners.httpUrl })
    .from(runners)
    .where(ne(runners.status, 'offline'));

  const withUrl = onlineRunners.filter((r) => r.httpUrl);
  if (withUrl.length > 0) return withUrl[0].httpUrl!;

  // Fallback to configured default runner URL (useful for dev when runtime hasn't registered yet)
  if (DEFAULT_RUNNER_URL) {
    log.debug('Using DEFAULT_RUNNER_URL fallback', { namespace: 'proxy', url: DEFAULT_RUNNER_URL });
    return DEFAULT_RUNNER_URL;
  }

  return null;
}

async function resolveByProject(projectId: string): Promise<string | null> {
  // Find all runner assignments for this project
  const assignments = await db
    .select({
      runnerId: runnerProjectAssignments.runnerId,
      httpUrl: runners.httpUrl,
      status: runners.status,
    })
    .from(runnerProjectAssignments)
    .innerJoin(runners, eq(runners.id, runnerProjectAssignments.runnerId))
    .where(eq(runnerProjectAssignments.projectId, projectId));

  // Filter to online runners with httpUrl
  const online = assignments.filter((a) => a.status !== 'offline' && a.httpUrl);
  if (online.length === 0) {
    log.warn('No online runner found for project', { namespace: 'proxy', projectId });
    return null;
  }

  // Return the first online runner's httpUrl
  return online[0].httpUrl!;
}
