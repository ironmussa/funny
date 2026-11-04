import type { PRDetail, PRReviewThread } from '@funny/shared';

import { githubApi } from '@/lib/api/github';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { DataRequestError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * A pull request's detail (checks, review state) and review threads as shared
 * `QueryClient` queries keyed by project and PR number. Freshness replaces the
 * former 30 s cooldown maps of `pr-detail-store`. React reads them through
 * `hooks.ts`; the components that show a PR decide when to fetch or poll.
 */

const log = createClientLogger('pull-request-queries');

/** GitHub rate limits are tight; polling every few seconds would burn them. */
const PR_STALE_MS = 30_000;

export function prDetailQuery(projectId: string, prNumber: number) {
  return {
    queryKey: ['pr-detail', projectId, prNumber] as const,
    queryFn: (): Promise<PRDetail> =>
      trackRateLimit(unwrapResult(githubApi.githubPRDetail(projectId, prNumber))),
    staleTime: PR_STALE_MS,
  };
}

export function prThreadsQuery(projectId: string, prNumber: number) {
  return {
    queryKey: ['pr-threads', projectId, prNumber] as const,
    queryFn: (): Promise<PRReviewThread[]> =>
      trackRateLimit(
        unwrapResult(githubApi.githubPRThreads(projectId, prNumber)).then((r) => r.threads),
      ),
    staleTime: PR_STALE_MS,
  };
}

// ── GitHub rate limit ───────────────────────────────────────

/**
 * Whether the last PR request hit GitHub's rate limit. While set, polling
 * pauses; an explicit refresh still runs and clears it on success.
 */
export const githubRateLimitQuery = {
  queryKey: ['github-rate-limited'] as const,
  queryFn: (): boolean => false,
  staleTime: Infinity,
  enabled: false,
};

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof DataRequestError ? error.domainError.message : '';
  return message.includes('403') || message.includes('429');
}

function trackRateLimit<T>(request: Promise<T>, layer: DataLayer = getDataLayer()): Promise<T> {
  const setRateLimited = (value: boolean) =>
    layer.queryClient.setQueryData(githubRateLimitQuery.queryKey, value);
  return request.then(
    (value) => {
      setRateLimited(false);
      return value;
    },
    (error: unknown) => {
      if (isRateLimitError(error)) {
        log.warn('GitHub rate limit reached; PR polling paused');
        setRateLimited(true);
      }
      throw error;
    },
  );
}

export function isGithubRateLimited(layer: DataLayer = getDataLayer()): boolean {
  return layer.queryClient.getQueryData<boolean>(githubRateLimitQuery.queryKey) ?? false;
}

// ── Fetching ────────────────────────────────────────────────

export interface PRFetchOptions {
  /** Ignore freshness and the rate-limit pause (an explicit refresh). */
  force?: boolean;
}

function fetchPRQuery(
  query: { queryKey: readonly unknown[]; queryFn: () => unknown; staleTime: number },
  { force = false }: PRFetchOptions,
  layer: DataLayer,
): Promise<void> {
  if (!force && isGithubRateLimited(layer)) return Promise.resolve();
  // Failures stay in the query state; callers render the last good value.
  return layer.queryClient.fetchQuery(force ? { ...query, staleTime: 0 } : query).then(
    () => undefined,
    () => undefined,
  );
}

/** Fetch the PR's detail unless fresh. */
export function fetchPRDetail(
  projectId: string,
  prNumber: number,
  options: PRFetchOptions = {},
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  return fetchPRQuery(prDetailQuery(projectId, prNumber), options, layer);
}

/** Fetch the PR's review threads unless fresh. */
export function fetchPRThreads(
  projectId: string,
  prNumber: number,
  options: PRFetchOptions = {},
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  return fetchPRQuery(prThreadsQuery(projectId, prNumber), options, layer);
}

/** Mark the PR stale (after a push or PR action) so the next fetch runs at once. */
export function invalidatePR(
  projectId: string,
  prNumber: number,
  layer: DataLayer = getDataLayer(),
): void {
  for (const query of [prDetailQuery(projectId, prNumber), prThreadsQuery(projectId, prNumber)]) {
    void layer.queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'none' });
  }
}

/** Seed a PR's detail and/or threads (tests and stories). */
export function seedPR(
  projectId: string,
  prNumber: number,
  { detail, threads }: { detail?: PRDetail; threads?: PRReviewThread[] },
  layer: DataLayer = getDataLayer(),
): void {
  if (detail) layer.queryClient.setQueryData(prDetailQuery(projectId, prNumber).queryKey, detail);
  if (threads) {
    layer.queryClient.setQueryData(prThreadsQuery(projectId, prNumber).queryKey, threads);
  }
}
