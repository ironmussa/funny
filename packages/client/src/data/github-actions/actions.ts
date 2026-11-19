import { githubApi } from '@/lib/api/github';

import { unwrapResult } from '../query-client';
import { refreshActionRuns } from './queries';

/**
 * Ask GitHub to re-run a run's failed jobs, then re-read the runs. Rejects
 * with GitHub's message (e.g. a token without Actions write access).
 */
export async function rerunFailedJobs(projectId: string, runId: number): Promise<void> {
  await unwrapResult(githubApi.githubRerunFailedJobs(projectId, runId));
  refreshActionRuns(projectId);
}
