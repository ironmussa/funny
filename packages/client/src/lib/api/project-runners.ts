import type {
  ProjectRunnerSettingsResponse,
  UpdateProjectRunnerSettingsRequest,
} from '@funny/shared/runner-protocol';

import { request } from './_core';

export const projectRunnersApi = {
  getProjectRunnerSettings: (projectId: string) =>
    request<ProjectRunnerSettingsResponse>(`/projects/${projectId}/runner-settings`),
  updateProjectRunnerSettings: (projectId: string, data: UpdateProjectRunnerSettingsRequest) =>
    request<ProjectRunnerSettingsResponse>(`/projects/${projectId}/runner-settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  grantProjectRunner: (projectId: string, runnerId: string) =>
    request<ProjectRunnerSettingsResponse>(`/projects/${projectId}/runner-grants/${runnerId}`, {
      method: 'POST',
    }),
  revokeProjectRunner: (projectId: string, runnerId: string) =>
    request<ProjectRunnerSettingsResponse>(`/projects/${projectId}/runner-grants/${runnerId}`, {
      method: 'DELETE',
    }),
  setGeneralRunner: (runnerId: string | null) =>
    request<{ generalRunnerId: string | null }>('/projects/general-runner', {
      method: 'PUT',
      body: JSON.stringify({ runnerId }),
    }),
};
