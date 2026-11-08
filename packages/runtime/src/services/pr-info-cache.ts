/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 *
 * Per-branch PR info cache shared by the git routes and the `git:changed`
 * status path. `gh pr list` is a GitHub API call (~320ms, rate limited) that
 * runs on the shared process pool; without this cache the status refresh
 * after every file-changing tool call issued one. `null` is a valid cached
 * value meaning "no PR exists for this branch".
 */

import { getPRForBranch, type BranchPRInfo } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';

const PR_INFO_CACHE_TTL_MS = 60_000; // 1 minute

const prInfoCache = new Map<string, { data: BranchPRInfo | null; ts: number }>();
const prFetchInflight = new Map<string, Promise<BranchPRInfo | null>>();

function prCacheKey(projectPath: string, branch: string): string {
  return `${projectPath}::${branch}`;
}

/** Read cached PR info. Returns `undefined` on miss, `null` for known-no-PR, otherwise the cached value. */
export function getCachedPR(projectPath: string, branch: string): BranchPRInfo | null | undefined {
  const cached = prInfoCache.get(prCacheKey(projectPath, branch));
  if (!cached) return undefined;
  if (Date.now() - cached.ts >= PR_INFO_CACHE_TTL_MS) {
    prInfoCache.delete(prCacheKey(projectPath, branch));
    return undefined;
  }
  return cached.data;
}

/** Start (or join) the lookup for a branch; the result is cached on success. */
function fetchPR(
  projectPath: string,
  branch: string,
  ghEnv: Record<string, string> | undefined,
  background: boolean,
): Promise<BranchPRInfo | null> {
  const key = prCacheKey(projectPath, branch);
  const inflight = prFetchInflight.get(key);
  if (inflight) return inflight;
  const span = startSpan('github.pr_lookup', { attributes: { branch, background } });
  const promise = getPRForBranch(projectPath, branch, ghEnv).then(
    (pr) => {
      span.end('ok');
      prInfoCache.set(key, { data: pr, ts: Date.now() });
      return pr;
    },
    (error) => {
      span.end('error', String(error));
      throw error;
    },
  );
  prFetchInflight.set(key, promise);
  const clear = () => {
    if (prFetchInflight.get(key) === promise) prFetchInflight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/**
 * PR info for a branch: the cached value when fresh, otherwise one lookup
 * shared by every concurrent caller. A failed lookup resolves to `null`
 * (no PR badge) and is not cached, so the next call retries.
 */
export async function getPRInfoCached(
  projectPath: string,
  branch: string,
  ghEnv?: Record<string, string>,
): Promise<BranchPRInfo | null> {
  const cached = getCachedPR(projectPath, branch);
  if (cached !== undefined) return cached;
  try {
    return await fetchPR(projectPath, branch, ghEnv, false);
  } catch (error) {
    log.warn('PR lookup failed', { namespace: 'git-service', branch, error: String(error) });
    return null;
  }
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
  if (prFetchInflight.has(prCacheKey(projectPath, branch))) return;
  const cached = getCachedPR(projectPath, branch);
  if (cached !== undefined) {
    onUpdate?.(cached);
    return;
  }
  fetchPR(projectPath, branch, ghEnv, true).then(
    (pr) => onUpdate?.(pr),
    (error) => {
      log.warn('Background PR lookup failed', {
        namespace: 'git-service',
        branch,
        error: String(error),
      });
    },
  );
}

/**
 * Drop cached PR info for a branch in every project, e.g. right after a PR
 * was created for it, so the next status refresh shows it without waiting
 * for the TTL.
 */
export function invalidatePRInfo(branch: string): void {
  const suffix = `::${branch}`;
  for (const key of prInfoCache.keys()) {
    if (key.endsWith(suffix)) prInfoCache.delete(key);
  }
}

/** Test-only: clear all cached and in-flight PR lookups. */
export function resetPRInfoCacheForTests(): void {
  prInfoCache.clear();
  prFetchInflight.clear();
}
