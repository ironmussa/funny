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

import { lookupPRForBranch, type BranchPRInfo } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';

const PR_INFO_CACHE_TTL_MS = 60_000; // 1 minute

const prInfoCache = new Map<string, { data: BranchPRInfo | null; ts: number }>();
const prFetchInflight = new Map<string, Promise<BranchPRInfo | null>>();
// Bumped by invalidatePRInfo: a lookup that started before an invalidation
// must not write its (possibly stale) answer back afterwards.
const prGeneration = new Map<string, number>();

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
  const generation = prGeneration.get(key) ?? 0;
  // A failed lookup (gh error, rate limit, timeout) rejects instead of reading
  // as "no PR", so it is never cached and the next call retries.
  const promise = (async () => {
    const result = await lookupPRForBranch(projectPath, branch, ghEnv);
    if (result.isErr()) {
      span.end('error', result.error.message);
      throw new Error(result.error.message);
    }
    span.end('ok');
    if ((prGeneration.get(key) ?? 0) === generation) {
      prInfoCache.set(key, { data: result.value, ts: Date.now() });
    }
    return result.value;
  })();
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
  const keys = new Set([...prInfoCache.keys(), ...prFetchInflight.keys()]);
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    prInfoCache.delete(key);
    // Detach a lookup already in flight: callers start a fresh one, and its
    // completion can no longer overwrite the cache.
    prFetchInflight.delete(key);
    prGeneration.set(key, (prGeneration.get(key) ?? 0) + 1);
  }
}

/** Test-only: clear all cached and in-flight PR lookups. */
export function resetPRInfoCacheForTests(): void {
  prInfoCache.clear();
  prFetchInflight.clear();
  prGeneration.clear();
}
