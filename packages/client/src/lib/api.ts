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
  GitHubRepo,
  PaginatedMessages,
  QueuedMessage,
  ProjectHook,
  HookType,
  FunnyProjectConfig,
  Pipeline,
  PipelineRun,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { internal, processError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { startSpan, metric } from '@/lib/telemetry';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
// In the browser, always use relative URLs so requests go through the Vite proxy
// (which forwards to VITE_SERVER_URL). This keeps cookies same-origin.
// Only Tauri needs an absolute URL since there's no dev proxy.
const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

/**
 * Get the API base URL for a thread.
 * Remote threads route to the container's Funny server.
 * Local threads (and non-thread calls) use the default base.
 */
export function getBaseUrlForThread(thread?: { runtime?: string; containerUrl?: string }): string {
  if (thread?.runtime === 'remote' && thread.containerUrl) {
    return `${thread.containerUrl}/api`;
  }
  return BASE;
}

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

/** Set the auth token directly (used by bootstrap endpoint). */
export function setAuthToken(token: string) {
  authToken = token;
  if (!_initAuthPromise) {
    _initAuthPromise = Promise.resolve();
  }
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
      const method = init?.method || 'GET';
      const span = startSpan('http.client', {
        attributes: { 'http.method': method, 'http.url': path },
      });
      const t0 = performance.now();

      // Fail fast if circuit is open
      if (cb.state === 'open') {
        span.end('ERROR');
        throw internal('Server unavailable (circuit open)');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // W3C Trace Context — propagate client span to the server
        traceparent: span.traceparent,
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
          credentials:
            authMode === 'multi' || import.meta.env.VITE_SERVER_URL ? 'include' : 'same-origin',
        });
      } catch (networkError) {
        // Network error (server down, no connectivity, etc.)
        useCircuitBreakerStore.getState().recordFailure();
        span.end('ERROR');
        metric('http.client.duration', performance.now() - t0, {
          type: 'gauge',
          attributes: { method, path, status: '0' },
        });
        throw internal(String(networkError));
      }

      const durationMs = performance.now() - t0;
      metric('http.client.duration', durationMs, {
        type: 'gauge',
        attributes: { method, path, status: String(res.status) },
      });

      if (!res.ok) {
        span.end('ERROR');

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
        const rawError = body.error;
        const message =
          typeof rawError === 'string' && rawError.length > 0
            ? rawError
            : rawError
              ? JSON.stringify(rawError)
              : `HTTP ${res.status}`;
        // If the server returned stderr/exitCode, this was a process error
        if (body.stderr || body.exitCode != null) {
          throw processError(message, body.exitCode, body.stderr);
        }

        const STATUS_TYPE: Record<number, DomainError['type']> = {
          404: 'NOT_FOUND',
          403: 'FORBIDDEN',
          409: 'CONFLICT',
        };
        const type: DomainError['type'] =
          STATUS_TYPE[res.status] ?? (res.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
        throw { type, message } as DomainError;
      }

      // Successful response — reset circuit breaker
      span.end('OK');
      useCircuitBreakerStore.getState().recordSuccess();

      return res.json() as Promise<T>;
    })(),
    (error): DomainError => {
      if (typeof error === 'object' && error !== null && 'type' in error) {
        return error as DomainError;
      }
      return internal(String(error));
    },
  );
}

export const api = {
  // Projects
  listProjects: () => request<Project[]>('/projects'),
  createProject: (name: string, path: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  renameProject: (id: string, name: string) =>
    request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  updateProject: (
    id: string,
    data: {
      name?: string;
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
    },
  ) => request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  reorderProjects: (projectIds: string[]) =>
    request<void>('/projects/reorder', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  listBranches: (projectId: string) =>
    request<{ branches: string[]; defaultBranch: string | null; currentBranch: string | null }>(
      `/projects/${projectId}/branches`,
    ),
  checkoutPreflight: (projectId: string, branch: string) =>
    request<{
      canCheckout: boolean;
      currentBranch: string | null;
      reason?: string;
      conflictingFiles?: string[];
    }>(`/projects/${projectId}/checkout-preflight?branch=${encodeURIComponent(branch)}`),

  // Threads
  listThreads: (projectId?: string, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return request<Thread[]>(`/threads${qs ? `?${qs}` : ''}`);
  },
  searchThreadContent: (query: string, projectId?: string) => {
    const params = new URLSearchParams({ q: query });
    if (projectId) params.set('projectId', projectId);
    return request<{ threadIds: string[]; snippets: Record<string, string> }>(
      `/threads/search/content?${params.toString()}`,
    );
  },
  getThread: (id: string, messageLimit?: number) => {
    const params = messageLimit ? `?messageLimit=${messageLimit}` : '';
    return request<ThreadWithMessages>(`/threads/${id}${params}`);
  },
  getThreadMessages: (threadId: string, cursor: string, limit = 50) => {
    const params = new URLSearchParams({ cursor, limit: String(limit) });
    return request<PaginatedMessages>(`/threads/${threadId}/messages?${params.toString()}`);
  },
  getThreadEvents: (threadId: string) => {
    return request<{ events: Array<import('@funny/shared').ThreadEvent> }>(
      `/threads/${threadId}/events`,
    );
  },
  createThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    runtime?: string;
    provider?: string;
    model?: string;
    permissionMode?: string;
    baseBranch?: string;
    prompt: string;
    images?: ImageAttachment[];
    allowedTools?: string[];
    disallowedTools?: string[];
    fileReferences?: { path: string }[];
    worktreePath?: string;
    parentThreadId?: string;
  }) => request<Thread>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  createIdleThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    baseBranch?: string;
    prompt?: string;
    stage?: string;
    images?: ImageAttachment[];
  }) => request<Thread>('/threads/idle', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (
    threadId: string,
    content: string,
    opts?: {
      provider?: string;
      model?: string;
      permissionMode?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      fileReferences?: { path: string }[];
      baseBranch?: string;
      forceQueue?: boolean;
    },
    images?: ImageAttachment[],
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/message`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        provider: opts?.provider,
        model: opts?.model,
        permissionMode: opts?.permissionMode,
        images,
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        fileReferences: opts?.fileReferences,
        baseBranch: opts?.baseBranch,
        forceQueue: opts?.forceQueue,
      }),
    }),
  stopThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/stop`, { method: 'POST' }),
  approveTool: (
    threadId: string,
    toolName: string,
    approved: boolean,
    allowedTools?: string[],
    disallowedTools?: string[],
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/approve-tool`, {
      method: 'POST',
      body: JSON.stringify({ toolName, approved, allowedTools, disallowedTools }),
    }),
  deleteThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}`, { method: 'DELETE' }),
  updateToolCallOutput: (threadId: string, toolCallId: string, output: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/tool-calls/${toolCallId}`, {
      method: 'PATCH',
      body: JSON.stringify({ output }),
    }),

  // Queue management
  listQueue: (threadId: string) => request<QueuedMessage[]>(`/threads/${threadId}/queue`),
  updateQueuedMessage: (threadId: string, messageId: string, content: string) =>
    request<{ ok: boolean; queuedCount: number; message: QueuedMessage }>(
      `/threads/${threadId}/queue/${messageId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      },
    ),
  cancelQueuedMessage: (threadId: string, messageId: string) =>
    request<{ ok: boolean; queuedCount: number }>(`/threads/${threadId}/queue/${messageId}`, {
      method: 'DELETE',
    }),
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
  renameThread: (threadId: string, title: string) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  updateThreadStage: (threadId: string, stage: string) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage }),
    }),

  // Thread comments
  getThreadComments: (threadId: string) =>
    request<import('@funny/shared').ThreadComment[]>(`/threads/${threadId}/comments`),
  createThreadComment: (threadId: string, content: string) =>
    request<import('@funny/shared').ThreadComment>(`/threads/${threadId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  deleteThreadComment: (threadId: string, commentId: string) =>
    request(`/threads/${threadId}/comments/${commentId}`, { method: 'DELETE' }),
  listArchivedThreads: (params?: { page?: number; limit?: number; search?: string }) => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.search) p.set('search', params.search);
    const qs = p.toString();
    return request<{ threads: Thread[]; total: number; page: number; limit: number }>(
      `/threads/archived${qs ? `?${qs}` : ''}`,
    );
  },

  // Git
  getDiff: (threadId: string) => request<FileDiff[]>(`/git/${threadId}/diff`),
  getDiffSummary: (threadId: string, excludePatterns?: string[], maxFiles?: number) => {
    const params = new URLSearchParams();
    if (excludePatterns?.length) params.set('exclude', excludePatterns.join(','));
    if (maxFiles) params.set('maxFiles', String(maxFiles));
    const qs = params.toString();
    return request<import('@funny/shared').DiffSummaryResponse>(
      `/git/${threadId}/diff/summary${qs ? `?${qs}` : ''}`,
    );
  },
  getFileDiff: (threadId: string, filePath: string, staged: boolean) =>
    request<{ diff: string }>(
      `/git/${threadId}/diff/file?path=${encodeURIComponent(filePath)}&staged=${staged}`,
    ),
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
  commit: (threadId: string, message: string, amend?: boolean, noVerify?: boolean) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message, amend, noVerify }),
    }),
  runHookCommand: (threadId: string, hookIndex: number) =>
    request<{ success: boolean; output: string }>(`/git/${threadId}/run-hook-command`, {
      method: 'POST',
      body: JSON.stringify({ hookIndex }),
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
  generateCommitMessage: (threadId: string, includeUnstaged?: boolean) =>
    request<{ title: string; body: string }>(`/git/${threadId}/generate-commit-message`, {
      method: 'POST',
      body: JSON.stringify({ includeUnstaged: includeUnstaged ?? false }),
    }),
  addToGitignore: (threadId: string, pattern: string) =>
    request<{ ok: boolean }>(`/git/${threadId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),
  getGitStatuses: (projectId: string) =>
    request<{ statuses: GitStatusInfo[] }>(`/git/status?projectId=${projectId}`),
  getGitStatus: (threadId: string) => request<GitStatusInfo>(`/git/${threadId}/status`),
  getGitLog: (threadId: string, limit = 20) =>
    request<{
      entries: Array<{
        hash: string;
        shortHash: string;
        author: string;
        relativeDate: string;
        message: string;
      }>;
    }>(`/git/${threadId}/log?limit=${limit}`),
  pull: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/pull`, { method: 'POST' }),
  stash: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/stash`, { method: 'POST' }),
  stashPop: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/stash/pop`, { method: 'POST' }),
  stashList: (threadId: string) =>
    request<{ entries: Array<{ index: string; message: string; relativeDate: string }> }>(
      `/git/${threadId}/stash/list`,
    ),
  resetSoft: (threadId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/${threadId}/reset-soft`, { method: 'POST' }),

  // Project-based git (no thread needed — operates on the project's main directory)
  projectGitStatus: (projectId: string) =>
    request<Omit<import('@funny/shared').GitStatusInfo, 'threadId'>>(
      `/git/project/${projectId}/status`,
    ),
  projectDiffSummary: (projectId: string, excludePatterns?: string[], maxFiles?: number) => {
    const params = new URLSearchParams();
    if (excludePatterns?.length) params.set('exclude', excludePatterns.join(','));
    if (maxFiles) params.set('maxFiles', String(maxFiles));
    const qs = params.toString();
    return request<import('@funny/shared').DiffSummaryResponse>(
      `/git/project/${projectId}/diff/summary${qs ? `?${qs}` : ''}`,
    );
  },
  projectFileDiff: (projectId: string, filePath: string, staged: boolean) =>
    request<{ diff: string }>(
      `/git/project/${projectId}/diff/file?path=${encodeURIComponent(filePath)}&staged=${staged}`,
    ),
  projectStageFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectUnstageFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectRevertFiles: (projectId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/revert`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  projectCommit: (projectId: string, message: string, amend?: boolean, noVerify?: boolean) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message, amend, noVerify }),
    }),
  projectRunHookCommand: (projectId: string, hookIndex: number) =>
    request<{ success: boolean; output: string }>(`/git/project/${projectId}/run-hook-command`, {
      method: 'POST',
      body: JSON.stringify({ hookIndex }),
    }),
  projectPush: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/push`, { method: 'POST' }),
  projectPull: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/pull`, { method: 'POST' }),
  projectStash: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/stash`, {
      method: 'POST',
    }),
  projectStashPop: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/stash/pop`, {
      method: 'POST',
    }),
  projectStashList: (projectId: string) =>
    request<{ entries: Array<{ index: string; message: string; relativeDate: string }> }>(
      `/git/project/${projectId}/stash/list`,
    ),
  projectResetSoft: (projectId: string) =>
    request<{ ok: boolean; output?: string }>(`/git/project/${projectId}/reset-soft`, {
      method: 'POST',
    }),
  projectGitLog: (projectId: string, limit = 20) =>
    request<{
      entries: Array<{
        hash: string;
        shortHash: string;
        author: string;
        relativeDate: string;
        message: string;
      }>;
    }>(`/git/project/${projectId}/log?limit=${limit}`),
  projectGenerateCommitMessage: (projectId: string, includeUnstaged?: boolean) =>
    request<{ title: string; body: string }>(`/git/project/${projectId}/generate-commit-message`, {
      method: 'POST',
      body: JSON.stringify({ includeUnstaged: includeUnstaged ?? false }),
    }),
  projectAddToGitignore: (projectId: string, pattern: string) =>
    request<{ ok: boolean }>(`/git/project/${projectId}/gitignore`, {
      method: 'POST',
      body: JSON.stringify({ pattern }),
    }),

  // Git Workflow (server-side orchestration)
  startWorkflow: (threadId: string, params: import('@funny/shared').GitWorkflowRequest) =>
    request<{ workflowId: string }>(`/git/${threadId}/workflow`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  projectStartWorkflow: (projectId: string, params: import('@funny/shared').GitWorkflowRequest) =>
    request<{ workflowId: string }>(`/git/project/${projectId}/workflow`, {
      method: 'POST',
      body: JSON.stringify(params),
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
  runCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/start`, { method: 'POST' }),
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
    request<import('@funny/shared').WeaveStatus>(`/projects/${projectId}/weave/status`),
  configureWeave: (projectId: string) =>
    request<{ ok: boolean; status: import('@funny/shared').WeaveStatus }>(
      `/projects/${projectId}/weave/configure`,
      { method: 'POST' },
    ),

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
  // MCP Servers
  listMcpServers: (projectPath: string) =>
    request<{ servers: McpServer[] }>(
      `/mcp/servers?projectPath=${encodeURIComponent(projectPath)}`,
    ),
  addMcpServer: (data: McpAddRequest) =>
    request<{ ok: boolean }>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeMcpServer: (name: string, projectPath: string) =>
    request<{ ok: boolean }>(
      `/mcp/servers/${encodeURIComponent(name)}?projectPath=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' },
    ),
  getRecommendedMcpServers: () => request<{ servers: McpServer[] }>('/mcp/recommended'),
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
    request<Array<{ path: string; branch: string; commit: string; isMain: boolean }>>(
      `/worktrees?projectId=${projectId}`,
    ),
  createWorktree: (data: { projectId: string; branchName: string; baseBranch?: string }) =>
    request<{ path: string; branch: string }>('/worktrees', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeWorktree: (projectId: string, worktreePath: string) =>
    request<{ ok: boolean }>('/worktrees', {
      method: 'DELETE',
      body: JSON.stringify({ projectId, worktreePath }),
    }),

  // Skills
  listSkills: (projectPath?: string) =>
    request<{ skills: Skill[] }>(
      `/skills${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ''}`,
    ),
  addSkill: (identifier: string) =>
    request<{ ok: boolean }>('/skills', { method: 'POST', body: JSON.stringify({ identifier }) }),
  removeSkill: (name: string) =>
    request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getRecommendedSkills: () => request<{ skills: Skill[] }>('/skills/recommended'),

  // Plugins
  listPlugins: () => request<PluginListResponse>('/plugins'),

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

  // Pipelines
  listPipelines: (projectId: string) => request<Pipeline[]>(`/pipelines/project/${projectId}`),
  createPipeline: (data: {
    projectId: string;
    name: string;
    reviewModel?: string;
    fixModel?: string;
    maxIterations?: number;
    precommitFixEnabled?: boolean;
    precommitFixModel?: string;
    precommitFixMaxIterations?: number;
    reviewerPrompt?: string;
    correctorPrompt?: string;
    precommitFixerPrompt?: string;
    commitMessagePrompt?: string;
    testEnabled?: boolean;
    testCommand?: string;
    testFixEnabled?: boolean;
    testFixModel?: string;
    testFixMaxIterations?: number;
    testFixerPrompt?: string;
  }) => request<Pipeline>('/pipelines', { method: 'POST', body: JSON.stringify(data) }),
  updatePipeline: (
    id: string,
    data: Partial<{
      name: string;
      enabled: boolean;
      reviewModel: string;
      fixModel: string;
      maxIterations: number;
      precommitFixEnabled: boolean;
      precommitFixModel: string;
      precommitFixMaxIterations: number;
      reviewerPrompt: string;
      correctorPrompt: string;
      precommitFixerPrompt: string;
      commitMessagePrompt: string;
      testEnabled: boolean;
      testCommand: string;
      testFixEnabled: boolean;
      testFixModel: string;
      testFixMaxIterations: number;
      testFixerPrompt: string;
    }>,
  ) =>
    request<{ ok: boolean }>(`/pipelines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deletePipeline: (id: string) =>
    request<{ ok: boolean }>(`/pipelines/${id}`, { method: 'DELETE' }),
  listPipelineRuns: (threadId: string) =>
    request<PipelineRun[]>(`/pipelines/runs/thread/${threadId}`),

  // Browse (filesystem)
  browseRoots: () => request<{ roots: string[]; home: string }>('/browse/roots'),
  browseList: (path: string) =>
    request<{
      path: string;
      parent: string | null;
      dirs: Array<{ name: string; path: string }>;
      error?: string;
    }>(`/browse/list?path=${encodeURIComponent(path)}`),
  openInEditor: (path: string, editor: string) =>
    request<{ ok: boolean }>('/browse/open-in-editor', {
      method: 'POST',
      body: JSON.stringify({ path, editor }),
    }),
  openDirectory: (path: string) =>
    request<{ ok: boolean }>('/browse/open-directory', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  openTerminal: (path: string) =>
    request<{ ok: boolean }>('/browse/open-terminal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  repoName: (path: string) =>
    request<{ name: string }>(`/browse/repo-name?path=${encodeURIComponent(path)}`),
  remoteUrl: (path: string) =>
    request<{ url: string | null }>(`/browse/remote-url?path=${encodeURIComponent(path)}`),
  gitInit: (path: string) =>
    request<{ ok: boolean }>('/browse/git-init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  browseFiles: (path: string, query?: string) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    return request<{
      files: Array<{ path: string; type: 'file' | 'folder' } | string>;
      truncated: boolean;
    }>(`/browse/files?${params.toString()}`);
  },

  // GitHub
  githubStatus: () => request<{ connected: boolean; login?: string }>('/github/status'),
  githubStartDevice: () =>
    request<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>('/github/oauth/device', { method: 'POST' }),
  githubPoll: (deviceCode: string) =>
    request<{
      status: 'pending' | 'success' | 'expired' | 'denied';
      scopes?: string;
      interval?: number;
    }>('/github/oauth/poll', { method: 'POST', body: JSON.stringify({ deviceCode }) }),
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
  githubIssues: (
    projectId: string,
    params?: { state?: string; page?: number; per_page?: number },
  ) => {
    const p = new URLSearchParams({ projectId });
    if (params?.state) p.set('state', params.state);
    if (params?.page) p.set('page', String(params.page));
    if (params?.per_page) p.set('per_page', String(params.per_page));
    return request<{
      issues: import('@funny/shared').GitHubIssue[];
      hasMore: boolean;
      owner: string;
      repo: string;
    }>(`/github/issues?${p.toString()}`);
  },

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

  // Logs (observability)
  sendLogs: (
    logs: Array<{ level: string; message: string; attributes?: Record<string, string> }>,
  ) => request<{ ok: boolean }>('/logs', { method: 'POST', body: JSON.stringify({ logs }) }),

  // Setup
  setupStatus: () =>
    request<{
      claudeCli: {
        available: boolean;
        path: string | null;
        error: string | null;
        version: string | null;
      };
    }>('/setup/status'),

  // System
  getAvailableShells: () =>
    request<{
      shells: Array<{ id: string; label: string; path: string }>;
    }>('/system/shells'),

  // Profile
  getProfile: () => request<import('@funny/shared').UserProfile>('/profile'),

  updateProfile: (data: import('@funny/shared').UpdateProfileRequest) =>
    request<import('@funny/shared').UserProfile>('/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getTranscribeToken: () => request<{ token: string }>('/profile/transcribe-token'),

  isSetupCompleted: () => request<{ setupCompleted: boolean }>('/profile/setup-completed'),

  completeSetup: () =>
    request<import('@funny/shared').UserProfile>('/profile', {
      method: 'PUT',
      body: JSON.stringify({ setupCompleted: true }),
    }),

  // Files (internal editor)
  readFile: (path: string) =>
    request<{ content: string }>(`/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    request<{ ok: boolean }>('/files/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),

  // Team / Organization
  getTeamSettings: () =>
    request<{
      id: string;
      name: string;
      slug: string;
      logo: string | null;
      hasApiKey: boolean;
      defaultModel: string | null;
      defaultMode: string | null;
      defaultPermissionMode: string | null;
    }>('/team-settings'),
  updateTeamApiKey: (apiKey: string | null) =>
    request<{ ok: boolean; hasApiKey: boolean }>('/team-settings/api-key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  updateTeamDefaults: (data: {
    defaultModel?: string | null;
    defaultMode?: string | null;
    defaultPermissionMode?: string | null;
  }) =>
    request<{ ok: boolean }>('/team-settings/defaults', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getSmtpSettings: () =>
    request<{
      host: string;
      port: string;
      user: string;
      from: string;
      hasPassword: boolean;
      source: 'database' | 'environment' | 'none';
      configured: boolean;
    }>('/settings/smtp'),
  updateSmtpSettings: (data: {
    host: string;
    port: string;
    user: string;
    pass?: string;
    from: string;
  }) =>
    request<{ ok: boolean }>('/settings/smtp', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  testSmtpSettings: () =>
    request<{ ok: boolean; sentTo: string }>('/settings/smtp/test', { method: 'POST' }),

  listTeamProjects: () => request<import('@funny/shared').Project[]>('/team-projects'),
  addTeamProject: (projectId: string) =>
    request<{ ok: boolean }>('/team-projects', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }),
  removeTeamProject: (projectId: string) =>
    request<{ ok: boolean }>(`/team-projects/${projectId}`, { method: 'DELETE' }),

  // Test Runner
  listTestFiles: (projectId: string) =>
    request<import('@funny/shared').TestFile[]>(`/tests/${projectId}/files`),
  runTest: (projectId: string, file: string) =>
    request<import('@funny/shared').RunTestResponse>(`/tests/${projectId}/run`, {
      method: 'POST',
      body: JSON.stringify({ file }),
    }),
  stopTest: (projectId: string) =>
    request<{ ok: boolean }>(`/tests/${projectId}/stop`, { method: 'POST' }),

  // Invite Links
  listInviteLinks: () =>
    request<
      {
        id: string;
        token: string;
        role: string;
        expiresAt: string | null;
        maxUses: number | null;
        useCount: number;
        createdAt: string;
      }[]
    >('/invite-links'),
  createInviteLink: (data: { role?: string; expiresInDays?: number; maxUses?: number }) =>
    request<{
      id: string;
      token: string;
      role: string;
      expiresAt: string | null;
      maxUses: number | null;
      useCount: number;
      createdAt: string;
    }>('/invite-links', { method: 'POST', body: JSON.stringify(data) }),
  revokeInviteLink: (id: string) =>
    request<{ ok: boolean }>(`/invite-links/${id}`, { method: 'DELETE' }),
  acceptInviteLink: (token: string) =>
    request<{ ok: boolean; organizationId: string; alreadyMember?: boolean }>(
      '/invite-links/accept',
      { method: 'POST', body: JSON.stringify({ token }) },
    ),
  /** Verify an invite token (public — no auth required) */
  verifyInviteLink: (token: string) =>
    request<{
      valid: boolean;
      role: string;
      organizationName: string;
      organizationId: string;
    }>(`/invite-links/verify/${token}`),
  /** Register a new user via invite token (public — no auth required) */
  registerViaInvite: (data: {
    token: string;
    username: string;
    password: string;
    displayName?: string;
  }) =>
    request<{
      ok: boolean;
      user: { id: string; username: string; displayName: string };
      organizationId: string;
    }>('/invite-links/register', { method: 'POST', body: JSON.stringify(data) }),
};
