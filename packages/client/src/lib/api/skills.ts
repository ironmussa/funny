import type { AgentResourcesResult, PluginListResponse, ResourcePhase, Skill } from '@funny/shared';

import { request } from './_core';

export const skillsApi = {
  // Skills
  listSkills: (projectPath?: string) =>
    request<{ skills: Skill[] }>(
      `/skills${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ''}`,
    ),
  // Provider-scoped Agent Resources. Returns skills + slash-commands + MCP
  // resolved for the EFFECTIVE provider — Codex/Gemini/etc. get no Claude
  // `.claude` resources. Built-in/session commands are merged separately by the
  // composer (it already holds them from `agent:init`).
  listAgentResources: (opts: {
    projectPath?: string;
    projectId?: string;
    provider?: string;
    model?: string;
    phase?: ResourcePhase;
  }) => {
    const qs = new URLSearchParams();
    if (opts.projectPath) qs.set('projectPath', opts.projectPath);
    if (opts.projectId) qs.set('projectId', opts.projectId);
    if (opts.provider) qs.set('provider', opts.provider);
    if (opts.model) qs.set('model', opts.model);
    if (opts.phase) qs.set('phase', opts.phase);
    const q = qs.toString();
    return request<AgentResourcesResult>(`/skills/resources${q ? `?${q}` : ''}`);
  },
  addSkill: (identifier: string) =>
    request<{ ok: boolean }>('/skills', { method: 'POST', body: JSON.stringify({ identifier }) }),
  removeSkill: (name: string) =>
    request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getRecommendedSkills: () => request<{ skills: Skill[] }>('/skills/recommended'),

  // Plugins
  listPlugins: () => request<PluginListResponse>('/plugins'),
};
