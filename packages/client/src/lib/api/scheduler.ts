import { request } from './_core';

export interface SchedulerRun {
  threadId: string;
  pipelineRunId: string | null;
  attempt: number;
  nextRetryAtMs: number | null;
  lastEventAtMs: number;
  lastError: string | null;
  claimedAtMs: number;
  userId: string;
  tokensTotal: number;
  updatedAtMs: number;
}

export const schedulerApi = {
  listSchedulerRuns: () => request<{ runs: SchedulerRun[] }>('/scheduler/runs'),
  refreshScheduler: () => request<{ summary: unknown }>('/scheduler/refresh', { method: 'POST' }),
};
