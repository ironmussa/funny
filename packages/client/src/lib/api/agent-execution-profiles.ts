import type {
  CreateAgentExecutionProfileRequest,
  UpdateAgentExecutionProfileRequest,
  UpdateProjectAgentProfileBindingRequest,
} from '@funny/shared';

import { trpc, trpcCall } from './_trpc';

const procedures = trpc.settings;

export const agentExecutionProfilesApi = {
  listAgentExecutionProfiles: () => trpcCall(() => procedures.listAgentProfiles.query()),
  createAgentExecutionProfile: (data: CreateAgentExecutionProfileRequest) =>
    trpcCall(() => procedures.createAgentProfile.mutate(data)),
  updateAgentExecutionProfile: (id: string, data: UpdateAgentExecutionProfileRequest) =>
    trpcCall(() => procedures.updateAgentProfile.mutate({ id, data })),
  deleteAgentExecutionProfile: (id: string) =>
    trpcCall(() => procedures.deleteAgentProfile.mutate({ id })),
  getProjectAgentProfileBinding: (projectId: string) =>
    trpcCall(() => procedures.getProjectBinding.query({ projectId })),
  updateProjectAgentProfileBinding: (
    projectId: string,
    data: UpdateProjectAgentProfileBindingRequest,
  ) => trpcCall(() => procedures.setProjectBinding.mutate({ projectId, ...data })),
};
