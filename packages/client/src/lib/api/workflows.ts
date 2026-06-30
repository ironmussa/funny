import type {
  WorkflowCancelResponse,
  WorkflowDefinitionResponse,
  WorkflowListResponse,
  WorkflowRunResponse,
  WorkflowSaveResponse,
  WorkflowValidateResponse,
} from '@funny/shared/types/workflows';

import { request } from './_core';

export const workflowsApi = {
  listWorkflows: (projectId: string) =>
    request<WorkflowListResponse>(`/workflows?projectId=${encodeURIComponent(projectId)}`),
  getWorkflow: (projectId: string, name: string) =>
    request<WorkflowDefinitionResponse>(
      `/workflows/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    ),
  validateWorkflow: (yaml: string) =>
    request<WorkflowValidateResponse>('/workflows/validate', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),
  saveWorkflow: (projectId: string, name: string, yaml: string) =>
    request<WorkflowSaveResponse>(`/workflows/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ projectId, yaml }),
    }),
  runWorkflow: (
    name: string,
    body: { threadId: string; prompt?: string; inputs?: Record<string, unknown> },
  ) =>
    request<WorkflowRunResponse>(`/workflows/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelWorkflowRun: (runId: string) =>
    request<WorkflowCancelResponse>(`/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
};
