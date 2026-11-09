import type { SandboxState } from '@funny/shared/sandbox-machine';

import { request } from './_core';

/** A sandbox size a provider offers. */
export interface SandboxSize {
  id: string;
  vcpu: number;
  memoryGb: number;
  default?: boolean;
}

export interface SandboxProviderInfo {
  id: string;
  displayName: string;
  capabilities: { sizes: SandboxSize[] };
}

/** A user's stored provider connection (the credential is never returned). */
export interface InfraConnection {
  id: string;
  provider: string;
  label: string;
  accountLabel: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
}

/** The user's sandbox for one project (change project-sandboxes). */
export interface ProjectSandboxSettings {
  projectId: string;
  connectionId: string;
  sizeId: string;
  enabledByDefault: boolean;
  updatedAt: string;
}

export interface SaveProjectSandboxInput {
  connectionId: string;
  sizeId?: string;
  enabledByDefault: boolean;
}

/** The shared sandbox machine's states (type-only: the machine itself stays server-side). */
export type ThreadSandboxState = SandboxState;

export interface ThreadSandboxInfo {
  threadId: string;
  provider: string;
  state: ThreadSandboxState;
  error: string | null;
  updatedAt: string;
}

/** Sandbox provider connections and thread sandboxes (change thread-sandboxes). */
export const infraApi = {
  listSandboxProviders: () => request<{ providers: SandboxProviderInfo[] }>('/infra/providers'),
  listInfraConnections: () => request<{ connections: InfraConnection[] }>('/infra/connections'),
  addInfraConnection: (data: { provider: string; label: string; credential: string }) =>
    request<InfraConnection>('/infra/connections', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  testInfraConnection: (id: string) =>
    request<unknown>(`/infra/connections/${id}/test`, { method: 'POST' }),
  deleteInfraConnection: (id: string) =>
    request<{ ok: boolean }>(`/infra/connections/${id}`, { method: 'DELETE' }),
  getProjectSandbox: (projectId: string) =>
    request<{ settings: ProjectSandboxSettings | null }>(`/infra/projects/${projectId}/sandbox`),
  saveProjectSandbox: (projectId: string, data: SaveProjectSandboxInput) =>
    request<{ settings: ProjectSandboxSettings }>(`/infra/projects/${projectId}/sandbox`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  clearProjectSandbox: (projectId: string) =>
    request<{ ok: boolean }>(`/infra/projects/${projectId}/sandbox`, { method: 'DELETE' }),
  getThreadSandbox: (threadId: string) =>
    request<ThreadSandboxInfo>(`/infra/threads/${threadId}/sandbox`),
};
