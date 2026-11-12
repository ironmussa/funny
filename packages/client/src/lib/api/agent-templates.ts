import type { CreateAgentTemplateRequest, UpdateAgentTemplateRequest } from '@funny/shared';

import { trpc, trpcCall } from './_trpc';

const procedures = trpc.agentTemplates;

export const agentTemplatesApi = {
  listAgentTemplates: () => trpcCall(() => procedures.list.query()),
  getAgentTemplate: (id: string) => trpcCall(() => procedures.get.query({ id })),
  createAgentTemplate: (data: CreateAgentTemplateRequest) =>
    trpcCall(() => procedures.create.mutate(data)),
  updateAgentTemplate: (id: string, data: UpdateAgentTemplateRequest) =>
    trpcCall(() => procedures.update.mutate({ id, data })),
  deleteAgentTemplate: (id: string) => trpcCall(() => procedures.remove.mutate({ id })),
  duplicateAgentTemplate: (id: string) => trpcCall(() => procedures.duplicate.mutate({ id })),
  getAgentTemplateUsageStats: () => trpcCall(() => procedures.usageStats.query()),
};
