import type {
  CreateAutomationRequest,
  RunTriageStatus,
  UpdateAutomationRequest,
} from '@funny/shared';

import { trpc, trpcCall } from './_trpc';

const procedures = trpc.automations;

export const automationsApi = {
  listAutomations: (projectId?: string) => trpcCall(() => procedures.list.query({ projectId })),
  getAutomation: (id: string) => trpcCall(() => procedures.get.query({ id })),
  createAutomation: (data: CreateAutomationRequest) =>
    trpcCall(() => procedures.create.mutate(data)),
  updateAutomation: (id: string, data: UpdateAutomationRequest) =>
    trpcCall(() => procedures.update.mutate({ id, data })),
  deleteAutomation: (id: string) => trpcCall(() => procedures.remove.mutate({ id })),
  triggerAutomation: (id: string) => trpcCall(() => procedures.trigger.mutate({ id })),
  listAutomationRuns: (automationId: string) =>
    trpcCall(() => procedures.runs.query({ id: automationId })),
  getAutomationInbox: (options?: { projectId?: string; triageStatus?: string }) =>
    trpcCall(() => procedures.inbox.query(options)),
  triageRun: (runId: string, triageStatus: RunTriageStatus) =>
    trpcCall(() => procedures.triageRun.mutate({ runId, triageStatus })),
};
