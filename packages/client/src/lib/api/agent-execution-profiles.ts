import type {
  AgentExecutionProfileResponse,
  CreateAgentExecutionProfileRequest,
  ProjectAgentProfileBindingResponse,
  UpdateAgentExecutionProfileRequest,
  UpdateProjectAgentProfileBindingRequest,
} from '@funny/shared';

import { request } from './_core';

export const agentExecutionProfilesApi = {
  listAgentExecutionProfiles: () =>
    request<{ profiles: AgentExecutionProfileResponse[] }>('/settings/agent-profiles'),
  createAgentExecutionProfile: (data: CreateAgentExecutionProfileRequest) =>
    request<AgentExecutionProfileResponse>('/settings/agent-profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAgentExecutionProfile: (id: string, data: UpdateAgentExecutionProfileRequest) =>
    request<AgentExecutionProfileResponse>(`/settings/agent-profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteAgentExecutionProfile: (id: string) =>
    request<{ ok: boolean }>(`/settings/agent-profiles/${id}`, { method: 'DELETE' }),
  getProjectAgentProfileBinding: (projectId: string) =>
    request<ProjectAgentProfileBindingResponse>(`/settings/agent-profiles/projects/${projectId}`),
  updateProjectAgentProfileBinding: (
    projectId: string,
    data: UpdateProjectAgentProfileBindingRequest,
  ) =>
    request<ProjectAgentProfileBindingResponse>(`/settings/agent-profiles/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};
