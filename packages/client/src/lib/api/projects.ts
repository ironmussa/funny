import type {
  FunnyProjectConfig,
  HookType,
  Project,
  ProjectHook,
  StartupCommand,
  WeaveStatus,
} from '@funny/shared';

import { request } from './_core';

export const projectsApi = {
  // Projects
  listProjects: (orgId?: string | null) => {
    const params = new URLSearchParams();
    if (orgId) {
      params.append('orgId', orgId);
    } else if (orgId === null) {
      params.append('personal', 'true');
    }
    const qs = params.toString();
    return request<Project[]>(`/projects${qs ? `?${qs}` : ''}`);
  },
  createProject: (name: string, path: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  updateProject: (
    id: string,
    data: {
      name?: string;
      path?: string;
      color?: string | null;
      followUpMode?: string;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultMode?: string | null;
      defaultPermissionMode?: string | null;
      defaultBranch?: string | null;
      urls?: string[] | null;
      systemPrompt?: string | null;
      launcherUrl?: string | null;
      defaultAgentTemplateId?: string | null;
    },
  ) => request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  reorderProjects: (projectIds: string[]) =>
    request<void>('/projects/reorder', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  setProjectLocalPath: (projectId: string, localPath: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/local-path`, {
      method: 'POST',
      body: JSON.stringify({ localPath }),
    }),
  listBranches: (projectId: string, signal?: AbortSignal) =>
    request<{
      branches: string[];
      remoteBranches: string[];
      defaultBranch: string | null;
      currentBranch: string | null;
    }>(`/projects/${projectId}/branches`, { signal }),
  checkoutPreflight: (projectId: string, branch: string) =>
    request<{
      canCheckout: boolean;
      currentBranch: string | null;
      reason?: string;
      hasDirtyFiles?: boolean;
      dirtyFileCount?: number;
    }>(`/projects/${projectId}/checkout-preflight?branch=${encodeURIComponent(branch)}`),
  checkout: (
    projectId: string,
    branch: string,
    strategy: 'stash' | 'carry' = 'carry',
    create = false,
    threadId?: string,
  ) =>
    request<{ ok: boolean; currentBranch: string }>(`/projects/${projectId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ branch, strategy, create, threadId }),
    }),

  // Startup Commands
  listCommands: (projectId: string) => request<StartupCommand[]>(`/projects/${projectId}/commands`),
  addCommand: (projectId: string, label: string, command: string) =>
    request<StartupCommand>(`/projects/${projectId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ label, command }),
    }),
  updateCommand: (projectId: string, cmdId: string, label: string, command: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}`, {
      method: 'PUT',
      body: JSON.stringify({ label, command }),
    }),
  deleteCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}`, { method: 'DELETE' }),
  runCommand: (projectId: string, cmdId: string, threadId?: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/start`, {
      method: 'POST',
      body: JSON.stringify(threadId ? { threadId } : {}),
    }),
  stopCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/stop`, { method: 'POST' }),

  // Project Config (.funny.json)
  getProjectConfig: (projectId: string) =>
    request<FunnyProjectConfig>(`/projects/${projectId}/config`),
  updateProjectConfig: (projectId: string, config: FunnyProjectConfig) =>
    request<{ ok: boolean }>(`/projects/${projectId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  // Weave Semantic Merge
  getWeaveStatus: (projectId: string) =>
    request<WeaveStatus>(`/projects/${projectId}/weave/status`),
  configureWeave: (projectId: string) =>
    request<{ ok: boolean; status: WeaveStatus }>(`/projects/${projectId}/weave/configure`, {
      method: 'POST',
    }),

  // Project Hooks (Husky-backed)
  listHooks: (projectId: string, hookType?: HookType) =>
    request<ProjectHook[]>(
      `/projects/${projectId}/hooks${hookType ? `?hookType=${hookType}` : ''}`,
    ),
  addHook: (projectId: string, data: { hookType?: HookType; label: string; command: string }) =>
    request<ProjectHook>(`/projects/${projectId}/hooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateHook: (
    projectId: string,
    hookType: HookType,
    index: number,
    data: {
      label?: string;
      command?: string;
      enabled?: boolean;
      hookType?: HookType;
    },
  ) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/${hookType}/${index}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteHook: (projectId: string, hookType: HookType, index: number) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/${hookType}/${index}`, {
      method: 'DELETE',
    }),
  reorderHooks: (projectId: string, hookType: HookType, newOrder: number[]) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ hookType, newOrder }),
    }),
};
