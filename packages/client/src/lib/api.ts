import type {
  Project,
  Thread,
  ThreadWithMessages,
  FileDiff,
  GitStatusInfo,
  StartupCommand,
  McpServer,
  McpAddRequest,
  Skill,
  PluginListResponse,
  ImageAttachment,
  Automation,
  AutomationRun,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  InboxItem,
} from '@a-parallel/shared';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

// ── Auth token ──────────────────────────────────────────────────
let authToken: string | null = null;

/** Fetch the auth token from the server. Call once at app startup. */
export async function initAuth(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/auth/token`);
    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
    }
  } catch (e) {
    console.error('[auth] Failed to fetch auth token:', e);
  }
}

/** Get the current auth token (for WebSocket connections). */
export function getAuthToken(): string | null {
  return authToken;
}

// ── API Error ───────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Request helper ──────────────────────────────────────────────
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  // Merge any caller-provided headers
  if (init?.headers) {
    Object.assign(headers, init.headers);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }
  return res.json();
}

export const api = {
  // Projects
  listProjects: () => request<Project[]>('/projects'),
  createProject: (name: string, path: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  listBranches: (projectId: string) =>
    request<{ branches: string[]; defaultBranch: string | null }>(`/projects/${projectId}/branches`),

  // Threads
  listThreads: (projectId?: string) =>
    request<Thread[]>(`/threads${projectId ? `?projectId=${projectId}` : ''}`),
  getThread: (id: string) => request<ThreadWithMessages>(`/threads/${id}`),
  createThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    model?: string;
    permissionMode?: string;
    baseBranch?: string;
    prompt: string;
    images?: ImageAttachment[];
  }) => request<Thread>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (threadId: string, content: string, opts?: { model?: string; permissionMode?: string }, images?: ImageAttachment[]) =>
    request<{ ok: boolean }>(`/threads/${threadId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, model: opts?.model, permissionMode: opts?.permissionMode, images }),
    }),
  stopThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/stop`, { method: 'POST' }),
  deleteThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}`, { method: 'DELETE' }),
  archiveThread: (threadId: string, archived: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  listArchivedThreads: (params?: { page?: number; limit?: number; search?: string }) => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.search) p.set('search', params.search);
    const qs = p.toString();
    return request<{ threads: Thread[]; total: number; page: number; limit: number }>(
      `/threads/archived${qs ? `?${qs}` : ''}`
    );
  },

  // Git
  getDiff: (threadId: string) => request<FileDiff[]>(`/git/${threadId}/diff`),
  stageFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  unstageFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  revertFiles: (threadId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/${threadId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  commit: (threadId: string, message: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  push: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/push`, { method: 'POST' }),
  createPR: (threadId: string, title: string, body: string) =>
    request<{ ok: boolean; url?: string }>(`/git/${threadId}/pr`, {
      method: 'POST',
      body: JSON.stringify({ title, body }),
    }),
  merge: (threadId: string, opts?: { targetBranch?: string; push?: boolean; cleanup?: boolean }) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/merge`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }),
  generateCommitMessage: (threadId: string) =>
    request<{ message: string }>(`/git/${threadId}/generate-commit-message`, {
      method: 'POST',
    }),
  getGitStatuses: (projectId: string) =>
    request<{ statuses: GitStatusInfo[] }>(`/git/status?projectId=${projectId}`),
  getGitStatus: (threadId: string) =>
    request<GitStatusInfo>(`/git/${threadId}/status`),

  // Startup Commands
  listCommands: (projectId: string) =>
    request<StartupCommand[]>(`/projects/${projectId}/commands`),
  addCommand: (projectId: string, label: string, command: string, port?: number | null, portEnvVar?: string | null) =>
    request<StartupCommand>(`/projects/${projectId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ label, command, port: port || null, portEnvVar: portEnvVar || null }),
    }),
  updateCommand: (projectId: string, cmdId: string, label: string, command: string, port?: number | null, portEnvVar?: string | null) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}`, {
      method: 'PUT',
      body: JSON.stringify({ label, command, port: port || null, portEnvVar: portEnvVar || null }),
    }),
  deleteCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}`, { method: 'DELETE' }),
  runCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/start`, { method: 'POST' }),
  stopCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/stop`, { method: 'POST' }),

  // MCP Servers
  listMcpServers: (projectPath: string) =>
    request<{ servers: McpServer[] }>(`/mcp/servers?projectPath=${encodeURIComponent(projectPath)}`),
  addMcpServer: (data: McpAddRequest) =>
    request<{ ok: boolean }>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeMcpServer: (name: string, projectPath: string) =>
    request<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(name)}?projectPath=${encodeURIComponent(projectPath)}`, { method: 'DELETE' }),
  getRecommendedMcpServers: () =>
    request<{ servers: McpServer[] }>('/mcp/recommended'),

  // Worktrees
  listWorktrees: (projectId: string) =>
    request<Array<{ path: string; branch: string; commit: string; isMain: boolean }>>(`/worktrees?projectId=${projectId}`),
  createWorktree: (data: { projectId: string; branchName: string; baseBranch?: string }) =>
    request<{ path: string; branch: string }>('/worktrees', { method: 'POST', body: JSON.stringify(data) }),
  removeWorktree: (projectId: string, worktreePath: string) =>
    request<{ ok: boolean }>('/worktrees', {
      method: 'DELETE',
      body: JSON.stringify({ projectId, worktreePath }),
    }),

  // Skills
  listSkills: (projectPath?: string) =>
    request<{ skills: Skill[] }>(`/skills${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ''}`),
  addSkill: (identifier: string) =>
    request<{ ok: boolean }>('/skills', { method: 'POST', body: JSON.stringify({ identifier }) }),
  removeSkill: (name: string) =>
    request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getRecommendedSkills: () =>
    request<{ skills: Skill[] }>('/skills/recommended'),

  // Plugins
  listPlugins: () =>
    request<PluginListResponse>('/plugins'),

  // Automations
  listAutomations: (projectId?: string) =>
    request<Automation[]>(`/automations${projectId ? `?projectId=${projectId}` : ''}`),
  getAutomation: (id: string) => request<Automation>(`/automations/${id}`),
  createAutomation: (data: CreateAutomationRequest) =>
    request<Automation>('/automations', { method: 'POST', body: JSON.stringify(data) }),
  updateAutomation: (id: string, data: UpdateAutomationRequest) =>
    request<Automation>(`/automations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAutomation: (id: string) =>
    request<{ ok: boolean }>(`/automations/${id}`, { method: 'DELETE' }),
  triggerAutomation: (id: string) =>
    request<{ ok: boolean }>(`/automations/${id}/trigger`, { method: 'POST' }),
  listAutomationRuns: (automationId: string) =>
    request<AutomationRun[]>(`/automations/${automationId}/runs`),
  getAutomationInbox: () =>
    request<InboxItem[]>('/automations/inbox'),
  triageRun: (runId: string, triageStatus: 'pending' | 'reviewed' | 'dismissed') =>
    request<{ ok: boolean }>(`/automations/runs/${runId}/triage`, {
      method: 'PATCH',
      body: JSON.stringify({ triageStatus }),
    }),
};
