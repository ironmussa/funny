const isTauri = !!(window as any).__TAURI_INTERNALS__;
const BASE = isTauri ? 'http://localhost:3001/api' : '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Projects
export const api = {
  // Projects
  listProjects: () => request<any[]>('/projects'),
  createProject: (name: string, path: string) =>
    request<any>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  deleteProject: (id: string) => request<any>(`/projects/${id}`, { method: 'DELETE' }),
  listBranches: (projectId: string) => request<string[]>(`/projects/${projectId}/branches`),

  // Threads
  listThreads: (projectId?: string) =>
    request<any[]>(`/threads${projectId ? `?projectId=${projectId}` : ''}`),
  getThread: (id: string) => request<any>(`/threads/${id}`),
  createThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    model?: string;
    permissionMode?: string;
    branch?: string;
    prompt: string;
    images?: any[];
  }) => request<any>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (threadId: string, content: string, opts?: { model?: string; permissionMode?: string }, images?: any[]) =>
    request<any>(`/threads/${threadId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, model: opts?.model, permissionMode: opts?.permissionMode, images }),
    }),
  stopThread: (threadId: string) =>
    request<any>(`/threads/${threadId}/stop`, { method: 'POST' }),
  deleteThread: (threadId: string) =>
    request<any>(`/threads/${threadId}`, { method: 'DELETE' }),
  archiveThread: (threadId: string, archived: boolean) =>
    request<any>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),

  // Git
  getDiff: (threadId: string) => request<any[]>(`/git/${threadId}/diff`),
  stageFiles: (threadId: string, paths: string[]) =>
    request<any>(`/git/${threadId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  unstageFiles: (threadId: string, paths: string[]) =>
    request<any>(`/git/${threadId}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  revertFiles: (threadId: string, paths: string[]) =>
    request<any>(`/git/${threadId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  commit: (threadId: string, message: string) =>
    request<any>(`/git/${threadId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  push: (threadId: string) =>
    request<any>(`/git/${threadId}/push`, { method: 'POST' }),
  createPR: (threadId: string, title: string, body: string) =>
    request<any>(`/git/${threadId}/pr`, {
      method: 'POST',
      body: JSON.stringify({ title, body }),
    }),

  // Startup Commands
  listCommands: (projectId: string) =>
    request<any[]>(`/projects/${projectId}/commands`),
  addCommand: (projectId: string, label: string, command: string) =>
    request<any>(`/projects/${projectId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ label, command }),
    }),
  updateCommand: (projectId: string, cmdId: string, label: string, command: string) =>
    request<any>(`/projects/${projectId}/commands/${cmdId}`, {
      method: 'PUT',
      body: JSON.stringify({ label, command }),
    }),
  deleteCommand: (projectId: string, cmdId: string) =>
    request<any>(`/projects/${projectId}/commands/${cmdId}`, { method: 'DELETE' }),
  runCommand: (projectId: string, cmdId: string) =>
    request<any>(`/projects/${projectId}/commands/${cmdId}/start`, { method: 'POST' }),
  stopCommand: (projectId: string, cmdId: string) =>
    request<any>(`/projects/${projectId}/commands/${cmdId}/stop`, { method: 'POST' }),

  // MCP Servers
  listMcpServers: (projectPath: string) =>
    request<{ servers: any[] }>(`/mcp/servers?projectPath=${encodeURIComponent(projectPath)}`),
  addMcpServer: (data: any) =>
    request<{ ok: boolean }>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeMcpServer: (name: string, projectPath: string) =>
    request<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(name)}?projectPath=${encodeURIComponent(projectPath)}`, { method: 'DELETE' }),
  getRecommendedMcpServers: () =>
    request<{ servers: any[] }>('/mcp/recommended'),

  // Skills
  listSkills: () =>
    request<{ skills: any[] }>('/skills'),
  addSkill: (identifier: string) =>
    request<{ ok: boolean }>('/skills', { method: 'POST', body: JSON.stringify({ identifier }) }),
  removeSkill: (name: string) =>
    request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getRecommendedSkills: () =>
    request<{ skills: any[] }>('/skills/recommended'),
};
