import type { IssueFilterOptions } from '@funny/shared';

import { useDataQuery } from '../hooks';
import { issueFilterOptionsQuery } from './queries';

/** The Issues filter options of a project, loaded while `enabled` (the panel is visible). */
export function useIssueFilterOptions(projectId: string | null, enabled: boolean) {
  const { data, isPending, fetchStatus } = useDataQuery({
    ...issueFilterOptionsQuery(projectId ?? ''),
    enabled: enabled && !!projectId,
  });
  const options: IssueFilterOptions | null = data ?? null;
  return { options, loading: isPending && fetchStatus === 'fetching' };
}
