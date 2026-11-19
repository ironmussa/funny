import type { ActionJob, ActionJobLog, ActionRun, ActionRunsPage } from '@funny/shared';

import { useDataLayer, useDataQuery } from '../hooks';
import { githubRateLimitQuery } from '../pull-requests/queries';
import { actionJobLogQuery, actionJobsQuery, actionRunsQuery } from './queries';

/** Poll fast while a run is going, slowly otherwise; unchanged polls are free (ETag). */
const ACTIVE_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

export interface ActionRunsView {
  page: ActionRunsPage | undefined;
  loading: boolean;
  error: string | null;
  rateLimited: boolean;
}

/** The project's workflow runs (one branch, or all with `branch` null), polled while `visible`. */
export function useActionRuns(
  projectId: string | undefined,
  branch: string | null,
  visible: boolean,
): ActionRunsView {
  const rateLimited = useDataQuery(githubRateLimitQuery).data ?? false;
  const enabled = Boolean(projectId) && visible && !rateLimited;
  const runsQuery = actionRunsQuery(projectId ?? '', branch);
  // Read on every render (each answer re-renders), so the interval follows the last answer.
  const cached = useDataLayer().queryClient.getQueryData<ActionRunsPage>(runsQuery.queryKey);
  const active = cached?.runs.some((run) => run.status !== 'completed') ?? false;
  const query = useDataQuery({
    ...runsQuery,
    enabled,
    refetchInterval: enabled ? (active ? ACTIVE_POLL_MS : IDLE_POLL_MS) : undefined,
  });
  return {
    page: projectId ? query.data : undefined,
    loading: query.isFetching,
    error: query.error ? query.error.message : null,
    rateLimited,
  };
}

/**
 * A run's jobs, fetched while the run is expanded, polled while it runs and
 * the tab is visible, never while GitHub's rate limit pauses polling.
 */
export function useActionJobs(
  projectId: string,
  run: ActionRun,
  visible: boolean,
): { jobs: ActionJob[] | undefined; loading: boolean; error: string | null } {
  const rateLimited = useDataQuery(githubRateLimitQuery).data ?? false;
  const polling = visible && !rateLimited && run.status !== 'completed';
  const query = useDataQuery({
    ...actionJobsQuery(projectId, run),
    enabled: visible && !rateLimited,
    refetchInterval: polling ? ACTIVE_POLL_MS : undefined,
  });
  return {
    jobs: query.data,
    loading: query.isFetching,
    error: query.error ? query.error.message : null,
  };
}

/** The end of a finished job's log, fetched once when asked for. */
export function useActionJobLog(
  projectId: string,
  jobId: number,
): { log: ActionJobLog | undefined; loading: boolean; error: string | null } {
  const query = useDataQuery(actionJobLogQuery(projectId, jobId));
  return {
    log: query.data,
    loading: query.isFetching,
    error: query.error ? query.error.message : null,
  };
}
