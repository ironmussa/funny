import type {
  CreateAutomationRequest,
  RunTriageStatus,
  UpdateAutomationRequest,
} from '@funny/shared';
import { automationsContract as contract } from '@funny/shared/contracts/automations';

import { callEndpoint } from './_contract';

export const automationsApi = {
  listAutomations: (projectId?: string) => callEndpoint(contract.list, { query: { projectId } }),
  getAutomation: (id: string) => callEndpoint(contract.get, { params: { id } }),
  createAutomation: (data: CreateAutomationRequest) =>
    callEndpoint(contract.create, { body: data }),
  updateAutomation: (id: string, data: UpdateAutomationRequest) =>
    callEndpoint(contract.update, { params: { id }, body: data }),
  deleteAutomation: (id: string) => callEndpoint(contract.remove, { params: { id } }),
  triggerAutomation: (id: string) => callEndpoint(contract.trigger, { params: { id } }),
  listAutomationRuns: (automationId: string) =>
    callEndpoint(contract.runs, { params: { id: automationId } }),
  getAutomationInbox: (options?: { projectId?: string; triageStatus?: string }) =>
    callEndpoint(contract.inbox, { query: options }),
  triageRun: (runId: string, triageStatus: RunTriageStatus) =>
    callEndpoint(contract.triageRun, { params: { runId }, body: { triageStatus } }),
};
