import type { PRDetail, PRReviewThread } from '@funny/shared';
import { useEffect } from 'react';

import { useDataQuery } from '../hooks';
import {
  fetchPRDetail,
  fetchPRThreads,
  githubRateLimitQuery,
  prDetailQuery,
  prThreadsQuery,
} from './queries';

const PR_POLL_INTERVAL_MS = 30_000;

export interface PRDetailView {
  detail: PRDetail | undefined;
  threads: PRReviewThread[] | undefined;
  loadingDetail: boolean;
  loadingThreads: boolean;
  rateLimited: boolean;
}

/**
 * React read of a PR's cached detail and review threads. It never fetches:
 * the component that shows the PR calls `fetchPRDetail` / `fetchPRThreads`
 * (and polls), so a reader of only the threads does not request the detail.
 */
export function usePRDetail(
  projectId: string | undefined,
  prNumber: number | undefined,
): PRDetailView {
  const pid = projectId ?? '';
  const num = prNumber ?? 0;
  const detail = useDataQuery({ ...prDetailQuery(pid, num), enabled: false });
  const threads = useDataQuery({ ...prThreadsQuery(pid, num), enabled: false });
  const rateLimited = useDataQuery(githubRateLimitQuery);
  const hasPR = Boolean(projectId && prNumber);
  return {
    detail: hasPR ? detail.data : undefined,
    threads: hasPR ? threads.data : undefined,
    loadingDetail: hasPR && detail.isFetching,
    loadingThreads: hasPR && threads.isFetching,
    rateLimited: rateLimited.data ?? false,
  };
}

/**
 * Fetch a PR on mount and poll it while `visible`. Each tick skips requests
 * that are still fresh or paused by GitHub's rate limit.
 */
export function usePRPolling(
  projectId: string | undefined,
  prNumber: number | undefined,
  visible: boolean,
  { threads = false }: { threads?: boolean } = {},
): void {
  useEffect(() => {
    if (!visible || !projectId || !prNumber) return;
    const fetchPR = () => {
      void fetchPRDetail(projectId, prNumber);
      if (threads) void fetchPRThreads(projectId, prNumber);
    };
    fetchPR();
    const timer = setInterval(fetchPR, PR_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [visible, projectId, prNumber, threads]);
}
