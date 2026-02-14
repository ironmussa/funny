import { ResultAsync } from 'neverthrow';
import type { DomainError } from '@a-parallel/shared/errors';
import { internal } from '@a-parallel/shared/errors';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
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
  UserProfile,
  UpdateProfileRequest,
  GitHubRepo,
} from '@a-parallel/shared';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

// ── Auth token ──────────────────────────────────────────
let authToken: string | null = null;

/** Fetch the auth token from the server. Call once at app startup. */
let _initAuthPromise: Promise<void> | null = null;
export function initAuth(): Promise<void> {
  if (_initAuthPromise) return _initAuthPromise;
  _initAuthPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/token`);
      if (res.ok) {
        const data = await res.json();
        authToken = data.token;
      }
    } catch (e) {
      console.error('[auth] Failed to fetch auth token:', e);
    }
  })();
  return _initAuthPromise;
}

/** Get the current auth token (for WebSocket connections). */
export function getAuthToken(): string | null {
  return authToken;
}

// ── Auth mode ────────────────────────────────────────────
let authMode: 'local' | 'multi' | null = null;

export function setAuthMode(mode: 'local' | 'multi') {
  authMode = mode;
}

export function getAuthMode() {
  return authMode;
}

// ── Request helper ──────────────────────────────────────
function request<T>(path: string, init?: RequestInit): ResultAsync<T, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const cb = useCircuitBreakerStore.getState();

      // Fail fast if circuit is open
      if (cb.state === 'open') {
        throw internal('Server unavailable (circuit open)');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      // In local mode, use Bearer token; in multi mode, rely on cookies
      if (authMode !== 'multi' && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      if (init?.headers) {
        Object.assign(headers, init.headers);
      }

      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, {
          ...init,
          headers,
          credentials: authMode === 'multi' ? 'include' : 'same-origin',
        });
      } catch (networkError) {
        // Network error (server down, no connectivity, etc.)
        useCircuitBreakerStore.getState().recordFailure();
        throw internal(String(networkError));
      }

      if (!res.ok) {
        // On 401 in multi mode, trigger logout
        if (res.status === 401 && authMode === 'multi') {
          import('@/stores/auth-store').then(({ useAuthStore }) => {
            useAuthStore.getState().logout();
          });
        }

        // 5xx errors trigger the circuit breaker; 4xx do NOT
        if (res.status >= 500) {
          useCircuitBreakerStore.getState().recordFailure();
        }

        const body = await res.json().catch(() => ({}));
        const message = body.error || `HTTP ${res.status}`;
        const type: DomainError['type'] = res.status === 404 ? 'NOT_FOUND'
          : res.status === 403 ? 'FORBIDDEN'
          : res.status === 409 ? 'CONFLICT'
          : res.status >= 500 ? 'INTERNAL'
          : 'BAD_REQUEST';
        throw { type, message } as DomainError;
      }

      // Successful response — reset circuit breaker
      useCircuitBreakerStore.getState().recordSuccess();

      return res.json() as Promise<T>;
    })(),
    (error): DomainError => {
      if (typeof error === 'object' && error !== null && 'type' in error) {
        return error as DomainError;
      }
      return internal(String(error));
    }
  );
}

export const api = {
  // Projects
  listProjects: () => request<Project[]>('/projects'),
  createProject: (name: string, path: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  updateProject: (id: string, data: { name?: string; color?: string | null }) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  reorderProjects: (projectIds: string[]) =>
    request<void>('/projects/reorder', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  listBranches: (projectId: string) =>
    request<{ branches: string[]; defaultBranch: string | null; currentBranch: string }>(`/projects/${projectId}/branches`),

  // Threads
  listThreads: (projectId?: string, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return request<Thread[]>(`/threads${qs ? `?${qs}` : ''}`);
  },
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
    allowedTools?: string[];
    disallowedTools?: string[];
    fileReferences?: { path: string }[];
  }) => request<Thread>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  createIdleThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    baseBranch?: string;
    prompt?: string;
  }) => request<Thread>('/threads/idle', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (threadId: string, content: string, opts?: { model?: string; permissionMode?: string; allowedTools?: string[]; disallowedTools?: string[]; fileReferences?: { path: string }[] }, images?: ImageAttachment[]) =>
    request<{ ok: boolean }>(`/threads/${threadId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, model: opts?.model, permissionMode: opts?.permissionMode, images, allowedTools: opts?.allowedTools, disallowedTools: opts?.disallowedTools, fileReferences: opts?.fileReferences }),
    }),
  stopThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/stop`, { method: 'POST' }),
  approveTool: (threadId: string, toolName: string, approved: boolean, allowedTools?: string[], disallowedTools?: string[]) =>
    request<{ ok: boolean }>(`/threads/${threadId}/approve-tool`, {
      method: 'POST',
      body: JSON.stringify({ toolName, approved, allowedTools, disallowedTools }),
    }),
  deleteThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}`, { method: 'DELETE' }),
  archiveThread: (threadId: string, archived: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  pinThread: (threadId: string, pinned: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  updateThreadStage: (threadId: string, stage: string) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage }),
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
    request<{ title: string; body: string }>(`/git/${threadId}/generate-commit-message`, {
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
  startMcpOAuth: (serverName: string, projectPath: string) =>
    request<{ authUrl: string }>('/mcp/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath }),
    }),
  setMcpToken: (serverName: string, projectPath: string, token: string) =>
    request<{ ok: boolean }>('/mcp/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ serverName, projectPath, token }),
    }),

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
  getAutomationInbox: (options?: { projectId?: string; triageStatus?: string }) => {
    const params = new URLSearchParams();
    if (options?.projectId) params.append('projectId', options.projectId);
    if (options?.triageStatus) params.append('triageStatus', options.triageStatus);
    const query = params.toString();
    return request<InboxItem[]>(`/automations/inbox${query ? `?${query}` : ''}`);
  },
  triageRun: (runId: string, triageStatus: 'pending' | 'reviewed' | 'dismissed') =>
    request<{ ok: boolean }>(`/automations/runs/${runId}/triage`, {
      method: 'PATCH',
      body: JSON.stringify({ triageStatus }),
    }),

  // Profile
  getProfile: () => request<UserProfile | null>('/profile'),
  updateProfile: (data: UpdateProfileRequest) =>
    request<UserProfile>('/profile', { method: 'PUT', body: JSON.stringify(data) }),

  // Browse (filesystem)
  browseRoots: () =>
    request<{ roots: string[]; home: string }>('/browse/roots'),
  browseList: (path: string) =>
    request<{ path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; error?: string }>(`/browse/list?path=${encodeURIComponent(path)}`),
  openInEditor: (path: string, editor: string) =>
    request<{ ok: boolean }>('/browse/open-in-editor', {
      method: 'POST',
      body: JSON.stringify({ path, editor }),
    }),
  repoName: (path: string) =>
    request<{ name: string }>(`/browse/repo-name?path=${encodeURIComponent(path)}`),
  gitInit: (path: string) =>
    request<{ ok: boolean }>('/browse/git-init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  browseFiles: (path: string, query?: string) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    return request<{ files: string[]; truncated: boolean }>(`/browse/files?${params.toString()}`);
  },

  // GitHub
  githubStatus: () =>
    request<{ connected: boolean; login?: string }>('/github/status'),
  githubStartDevice: () =>
    request<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
      '/github/oauth/device', { method: 'POST' }
    ),
  githubPoll: (deviceCode: string) =>
    request<{ status: 'pending' | 'success' | 'expired' | 'denied'; scopes?: string; interval?: number }>(
      '/github/oauth/poll', { method: 'POST', body: JSON.stringify({ deviceCode }) }
    ),
  githubDisconnect: () =>
    request<{ ok: boolean }>('/github/oauth/disconnect', { method: 'DELETE' }),
  githubUser: () =>
    request<{ login: string; avatar_url: string; name: string | null }>('/github/user'),
  githubRepos: (params?: { page?: number; per_page?: number; search?: string; sort?: string }) => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    if (params?.search) p.set('search', params.search);
    if (params?.sort) p.set('sort', params.sort);
    const qs = p.toString();
    return request<{ repos: GitHubRepo[]; hasMore: boolean }>(`/github/repos${qs ? `?${qs}` : ''}`);
  },
  cloneRepo: (cloneUrl: string, destinationPath: string, name?: string) =>
    request<Project>('/github/clone', {
      method: 'POST',
      body: JSON.stringify({ cloneUrl, destinationPath, name }),
    }),

  // Analytics
  analyticsOverview: (projectId?: string, timeRange?: string) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (timeRange) params.set('timeRange', timeRange);
    params.set('tz', String(new Date().getTimezoneOffset()));
    const qs = params.toString();
    return request<any>(`/analytics/overview${qs ? `?${qs}` : ''}`);
  },
  analyticsTimeline: (projectId?: string, timeRange?: string, groupBy?: string) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (timeRange) params.set('timeRange', timeRange);
    if (groupBy) params.set('groupBy', groupBy);
    params.set('tz', String(new Date().getTimezoneOffset()));
    const qs = params.toString();
    return request<any>(`/analytics/timeline${qs ? `?${qs}` : ''}`);
  },
};
