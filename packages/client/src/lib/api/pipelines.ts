import type { Pipeline, PipelineRun } from '@funny/shared';

import { request } from './_core';

export const pipelinesApi = {
  /** Answer a pipeline approval gate (human-in-the-loop). */
  respondToApproval: (
    approvalId: string,
    body: { decision: 'approve' | 'reject'; text?: string },
  ) =>
    request<{ ok: boolean }>(`/pipelines/approvals/${encodeURIComponent(approvalId)}/respond`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listPipelines: (projectId: string) => request<Pipeline[]>(`/pipelines/project/${projectId}`),
  createPipeline: (data: {
    projectId: string;
    name: string;
    reviewModel?: string;
    fixModel?: string;
    maxIterations?: number;
    precommitFixEnabled?: boolean;
    precommitFixModel?: string;
    precommitFixMaxIterations?: number;
    reviewerPrompt?: string;
    correctorPrompt?: string;
    precommitFixerPrompt?: string;
    commitMessagePrompt?: string;
    testEnabled?: boolean;
    testCommand?: string;
    testFixEnabled?: boolean;
    testFixModel?: string;
    testFixMaxIterations?: number;
    testFixerPrompt?: string;
  }) => request<Pipeline>('/pipelines', { method: 'POST', body: JSON.stringify(data) }),
  updatePipeline: (
    id: string,
    data: Partial<{
      name: string;
      enabled: boolean;
      reviewModel: string;
      fixModel: string;
      maxIterations: number;
      precommitFixEnabled: boolean;
      precommitFixModel: string;
      precommitFixMaxIterations: number;
      reviewerPrompt: string;
      correctorPrompt: string;
      precommitFixerPrompt: string;
      commitMessagePrompt: string;
      testEnabled: boolean;
      testCommand: string;
      testFixEnabled: boolean;
      testFixModel: string;
      testFixMaxIterations: number;
      testFixerPrompt: string;
    }>,
  ) =>
    request<{ ok: boolean }>(`/pipelines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deletePipeline: (id: string) =>
    request<{ ok: boolean }>(`/pipelines/${id}`, { method: 'DELETE' }),
  listPipelineRuns: (threadId: string) =>
    request<PipelineRun[]>(`/pipelines/runs/thread/${threadId}`),
};
