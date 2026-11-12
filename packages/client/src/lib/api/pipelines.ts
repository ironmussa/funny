import type {
  CreatePipelineRequest,
  UpdatePipelineRequest,
} from '@funny/shared/contracts/pipelines';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

const procedures = trpc.pipelines;

export const pipelinesApi = {
  /** Answer a pipeline approval gate (human-in-the-loop). Stays REST: it may be proxied to the runner. */
  respondToApproval: (
    approvalId: string,
    body: { decision: 'approve' | 'reject'; text?: string },
  ) =>
    request<{ ok: boolean }>(`/pipelines/approvals/${encodeURIComponent(approvalId)}/respond`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listPipelines: (projectId: string) => trpcCall(() => procedures.list.query({ projectId })),
  createPipeline: (data: CreatePipelineRequest) => trpcCall(() => procedures.create.mutate(data)),
  updatePipeline: (id: string, data: UpdatePipelineRequest) =>
    trpcCall(() => procedures.update.mutate({ id, data })),
  deletePipeline: (id: string) => trpcCall(() => procedures.remove.mutate({ id })),
  listPipelineRuns: (threadId: string) =>
    trpcCall(() => procedures.runsForThread.query({ threadId })),
};
