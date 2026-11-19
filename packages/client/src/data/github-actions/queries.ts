import type { ActionJob, ActionJobLog, ActionRunsPage } from '@funny/shared';

import { githubApi } from '@/lib/api/github';

import type { DataLayer } from '../data-layer';
import { trackRateLimit } from '../pull-requests/queries';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * GitHub Actions for the review pane's Actions tab, as session queries: the
 * repository's workflow runs (all branches, or one), a run's jobs and steps,
 * and the end of a finished job's log. They share the PR queries' rate-limit
 * flag, so a 403 / 429 pauses PR and Actions polling alike.
 */

const RUNS_STALE_MS = 15_000;

const actionRunsKey = (projectId: string) => ['actions-runs', projectId] as const;

/** `branch` null lists every branch's runs. */
export function actionRunsQuery(projectId: string, branch: string | null) {
  return {
    queryKey: [...actionRunsKey(projectId), branch ?? ''] as const,
    queryFn: (): Promise<ActionRunsPage> =>
      trackRateLimit(unwrapResult(githubApi.githubActionRuns(projectId, { branch }))),
    staleTime: RUNS_STALE_MS,
  };
}

export function actionJobsQuery(projectId: string, runId: number) {
  return {
    queryKey: ['actions-jobs', projectId, runId] as const,
    queryFn: (): Promise<ActionJob[]> =>
      trackRateLimit(
        unwrapResult(githubApi.githubActionJobs(projectId, runId)).then((r) => r.jobs),
      ),
    staleTime: RUNS_STALE_MS,
  };
}

/** A finished job's log never changes. */
export function actionJobLogQuery(projectId: string, jobId: number) {
  return {
    queryKey: ['actions-job-log', projectId, jobId] as const,
    queryFn: (): Promise<ActionJobLog> =>
      trackRateLimit(unwrapResult(githubApi.githubActionJobLog(projectId, jobId))),
    staleTime: Infinity,
  };
}

/** Re-read the run lists now (an explicit refresh, or after a re-run). */
export function refreshActionRuns(projectId: string, layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  void layer.queryClient.invalidateQueries({ queryKey: actionRunsKey(projectId) });
  void layer.queryClient.invalidateQueries({ queryKey: ['actions-jobs', projectId] });
}
