import type { PRDetail, PRReviewThread } from '@funny/shared';

import { useDataQuery } from '../hooks';
import { githubRateLimitQuery, prDetailQuery, prThreadsQuery } from './queries';

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
