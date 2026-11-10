import {
  pipelinesContract as contract,
  type CreatePipelineRequest,
  type UpdatePipelineRequest,
} from '@funny/shared/contracts/pipelines';

import { callEndpoint } from './_contract';
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
  listPipelines: (projectId: string) => callEndpoint(contract.list, { params: { projectId } }),
  createPipeline: (data: CreatePipelineRequest) => callEndpoint(contract.create, { body: data }),
  updatePipeline: (id: string, data: UpdatePipelineRequest) =>
    callEndpoint(contract.update, { params: { id }, body: data }),
  deletePipeline: (id: string) => callEndpoint(contract.remove, { params: { id } }),
  listPipelineRuns: (threadId: string) =>
    callEndpoint(contract.runsForThread, { params: { threadId } }),
};
