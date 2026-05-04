/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  fetchRemote,
  getPRForBranch,
  git,
  type BranchPRInfo,
  type GitIdentityOptions,
} from '@funny/core/git';
import { ok } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { startSpan } from '../../lib/telemetry.js';
import * as tm from '../../services/thread-manager.js';
import { wsBroker } from '../../services/ws-broker.js';
import { requireProject } from '../../utils/route-helpers.js';

// computeBranchKey is imported from utils/git-status-helpers.ts

// In-memory cache for bulk git status to avoid spawning excessive git processes.
export const _gitStatusCache = new Map<string, { data: any; ts: number }>();
export const GIT_STATUS_CACHE_TTL_MS = 2_000; // 2 seconds

// Throttled fetch: track last fetch time per project so we don't hammer the remote.
export const _lastFetchTs = new Map<string, number>();
export const FETCH_THROTTLE_MS = 30_000; // 30 seconds

// Per-branch PR info cache. `gh pr list` averages ~320ms per call and is the
// dominant cost in /api/git/:threadId/status. Cache result so the synchronous
// path is free, then refresh in the background and push updates via WS.
// `null` is a valid cached value meaning "no PR exists for this branch".
const _prInfoCache = new Map<string, { data: BranchPRInfo | null; ts: number }>();
const _prFetchInflight = new Set<string>();
export const PR_INFO_CACHE_TTL_MS = 60_000; // 1 minute

function prCacheKey(projectPath: string, branch: string): string {
  return `${projectPath}::${branch}`;
}

/** Read cached PR info. Returns `undefined` on miss, `null` for known-no-PR, otherwise the cached value. */
export function getCachedPR(projectPath: string, branch: string): BranchPRInfo | null | undefined {
  const cached = _prInfoCache.get(prCacheKey(projectPath, branch));
  if (!cached) return undefined;
  if (Date.now() - cached.ts >= PR_INFO_CACHE_TTL_MS) return undefined;
  return cached.data;
}

/**
 * Fire-and-forget PR lookup. Caches the result and invokes `onUpdate` so the
 * caller can broadcast a follow-up WS event with the freshly-resolved PR info.
 * Deduped per (projectPath, branch) so concurrent thread switches don't pile
 * up `gh pr list` invocations.
 */
export function schedulePRLookup(opts: {
  projectPath: string;
  branch: string;
  ghEnv?: Record<string, string>;
  onUpdate?: (pr: BranchPRInfo | null) => void;
}): void {
  const { projectPath, branch, ghEnv, onUpdate } = opts;
  const key = prCacheKey(projectPath, branch);
  if (_prFetchInflight.has(key)) return;
  const cached = _prInfoCache.get(key);
  if (cached && Date.now() - cached.ts < PR_INFO_CACHE_TTL_MS) {
    onUpdate?.(cached.data);
    return;
  }
  _prFetchInflight.add(key);
  const span = startSpan('github.pr_lookup', {
    attributes: { branch, background: true },
  });
  getPRForBranch(projectPath, branch, ghEnv).then(
    (pr) => {
      span.end('ok');
      _prInfoCache.set(key, { data: pr, ts: Date.now() });
      _prFetchInflight.delete(key);
      onUpdate?.(pr);
    },
    (error) => {
      span.end('error', String(error));
      _prFetchInflight.delete(key);
      log.warn('Background PR lookup failed', {
        namespace: 'git-service',
        branch,
        error: String(error),
      });
    },
  );
}

/**
 * Emit a `git:status` WS event for a single thread carrying just the PR fields.
 * Client merges by `branchKey`, so the existing status fields stay intact and
 * the PR badge appears as soon as the background lookup resolves.
 */
export function emitPRUpdateForThread(opts: {
  userId: string;
  threadId: string;
  branchKey: string;
  status: Record<string, unknown>;
  pr: BranchPRInfo | null;
}): void {
  const { userId, threadId, branchKey, status, pr } = opts;
  const merged = {
    ...status,
    threadId,
    branchKey,
    ...(pr ? { prNumber: pr.prNumber, prUrl: pr.prUrl, prState: pr.prState } : {}),
  };
  wsBroker.emitToUser(userId, {
    type: 'git:status',
    threadId,
    data: {
      statuses: [merged as unknown as import('@funny/shared').GitStatusInfo],
    },
  });
}

/** Invalidate cached git status for a project after mutating git operations. */
export async function invalidateGitStatusCache(threadId: string) {
  const thread = await tm.getThread(threadId);
  if (thread) _gitStatusCache.delete(thread.projectId);
}

/** Invalidate cached git status by project ID directly. Exported for use by event handlers. */
export function invalidateGitStatusCacheByProject(projectId: string) {
  _gitStatusCache.delete(projectId);
}

/**
 * Throttled background `git fetch`. Returns immediately; the network fetch runs
 * detached so /api/git/status responses aren't blocked by remote round-trips.
 * On completion, the per-project bulk cache is invalidated so the next status
 * call recomputes `unpulledCommitCount` against the freshly updated refs.
 *
 * Returns true when a fetch was scheduled, false when the throttle window
 * suppressed it. Callers don't need to await — the caller has already moved on.
 */
export function scheduleBackgroundFetch(
  projectId: string,
  projectPath: string,
  identity: GitIdentityOptions | undefined,
  attrs?: Record<string, string | number | boolean>,
): boolean {
  const lastFetch = _lastFetchTs.get(projectId) ?? 0;
  if (Date.now() - lastFetch <= FETCH_THROTTLE_MS) return false;
  _lastFetchTs.set(projectId, Date.now());

  const span = startSpan('git.fetch_remote', {
    attributes: { projectId, background: true, ...(attrs ?? {}) },
  });
  fetchRemote(projectPath, identity).match(
    () => {
      span.end('ok');
      _gitStatusCache.delete(projectId);
    },
    (error) => {
      span.end('error', error.message);
      log.warn('Background git fetch failed', {
        namespace: 'git-service',
        projectId,
        error: error.message,
      });
    },
  );
  return true;
}

/** Count unpushed commits on a branch vs its remote tracking branch. */
export async function countUnpushedCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `origin/${branch}..${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Count unpulled commits on a branch (commits on origin not yet in local). */
export async function countUnpulledCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `${branch}..origin/${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Resolve project path from projectId and verify ownership. */
export async function requireProjectCwd(
  projectId: string,
  userId?: string,
  organizationId?: string | null,
): Promise<import('neverthrow').Result<string, import('@funny/shared/errors').DomainError>> {
  const projectResult = await requireProject(projectId, userId, organizationId ?? undefined);
  if (projectResult.isErr()) return projectResult.map(() => '');
  return ok(projectResult.value.path);
}
