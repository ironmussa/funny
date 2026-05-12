import { request } from './_core';

export interface OrchestratorRun {
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

export const orchestratorApi = {
  listOrchestratorRuns: () => request<{ runs: OrchestratorRun[] }>('/orchestrator/runs'),
  refreshOrchestrator: () =>
    request<{ summary: unknown }>('/orchestrator/refresh', { method: 'POST' }),
};
