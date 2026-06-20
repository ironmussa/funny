import type { McpAddRequest, McpServer } from '@funny/shared';

import { request } from './_core';

export const mcpApi = {
  listMcpServers: (projectPath: string, provider = 'claude') =>
    request<{ servers: McpServer[] }>(
      `/mcp/servers?projectPath=${encodeURIComponent(projectPath)}&provider=${encodeURIComponent(provider)}`,
    ),
  addMcpServer: (data: McpAddRequest) =>
    request<{ ok: boolean }>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeMcpServer: (name: string, projectPath: string, provider = 'claude') =>
    request<{ ok: boolean }>(
      `/mcp/servers/${encodeURIComponent(name)}?projectPath=${encodeURIComponent(projectPath)}&provider=${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
    ),
  toggleMcpServer: (name: string, projectPath: string, disabled: boolean, provider = 'claude') =>
    request<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(name)}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ projectPath, provider, disabled }),
    }),
  getRecommendedMcpServers: () => request<{ servers: McpServer[] }>('/mcp/recommended'),
  startMcpOAuth: (serverName: string, projectPath: string, provider = 'claude') =>
    request<{ authUrl: string }>('/mcp/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath, provider }),
    }),
  setMcpToken: (serverName: string, projectPath: string, token: string, provider = 'claude') =>
    request<{ ok: boolean }>('/mcp/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath, provider, token }),
    }),
};
