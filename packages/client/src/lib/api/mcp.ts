import type { McpAddRequest, McpServer } from '@funny/shared';

import { request } from './_core';

function withProjectQuery(projectPath: string, provider: string, projectId?: string): string {
  const qs = new URLSearchParams();
  qs.set('projectPath', projectPath);
  qs.set('provider', provider);
  if (projectId) qs.set('projectId', projectId);
  return qs.toString();
}

export const mcpApi = {
  listMcpServers: (projectPath: string, provider = 'claude', projectId?: string) =>
    request<{ servers: McpServer[] }>(
      `/mcp/servers?${withProjectQuery(projectPath, provider, projectId)}`,
    ),
  addMcpServer: (data: McpAddRequest) =>
    request<{ ok: boolean }>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeMcpServer: (name: string, projectPath: string, provider = 'claude', projectId?: string) =>
    request<{ ok: boolean }>(
      `/mcp/servers/${encodeURIComponent(name)}?${withProjectQuery(projectPath, provider, projectId)}`,
      { method: 'DELETE' },
    ),
  toggleMcpServer: (
    name: string,
    projectPath: string,
    disabled: boolean,
    provider = 'claude',
    projectId?: string,
  ) =>
    request<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(name)}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ projectPath, projectId, provider, disabled }),
    }),
  getRecommendedMcpServers: () => request<{ servers: McpServer[] }>('/mcp/recommended'),
  startMcpOAuth: (
    serverName: string,
    projectPath: string,
    provider = 'claude',
    projectId?: string,
  ) =>
    request<{ authUrl: string }>('/mcp/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath, projectId, provider }),
    }),
  setMcpToken: (
    serverName: string,
    projectPath: string,
    token: string,
    provider = 'claude',
    projectId?: string,
  ) =>
    request<{ ok: boolean }>('/mcp/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath, projectId, provider, token }),
    }),
};
