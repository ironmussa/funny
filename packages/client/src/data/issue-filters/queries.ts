import type { IssueFilterOptions } from '@funny/shared';

import { githubApi } from '@/lib/api/github';

import { unwrapResult } from '../query-client';

/**
 * What the Issues filter dropdowns offer for a project (labels, users,
 * milestones, issue types, projects), one shared `QueryClient` query per
 * project. They change rarely, so a loaded entry stays fresh for a few minutes.
 */
const ISSUE_FILTER_OPTIONS_STALE_MS = 5 * 60_000;

export function issueFilterOptionsQuery(projectId: string) {
  return {
    queryKey: ['issue-filter-options', projectId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<IssueFilterOptions> =>
      unwrapResult(githubApi.githubIssueFilterOptions(projectId, signal)),
    staleTime: ISSUE_FILTER_OPTIONS_STALE_MS,
  };
}
