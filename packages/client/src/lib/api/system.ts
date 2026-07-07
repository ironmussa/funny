import type { AdvertisedProvider } from '@funny/shared/runner-protocol';

import { request } from './_core';

export type { AdvertisedProvider };

/** One contiguous run of same-commit lines from `GET /files/blame`. */
export interface BlameHunk {
  /** First line of the hunk, 1-based. */
  startLine: number;
  lineCount: number;
  commitHash: string;
  shortHash: string;
  author: string;
  relativeDate: string;
  summary: string;
}

export interface BlameResponse {
  hunks: BlameHunk[];
  /** Line count of the HEAD version; working-tree lines past it are uncommitted. */
  blamedLineCount: number;
}

export interface FileHistoryEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  path: string;
  previousPath: string | null;
}

/** A model advertised by a dynamic-catalog ACP provider (pi / cursor / opencode). */
export interface AcpModelEntry {
  modelId: string;
  name: string;
}

export type AcpModelsUnavailableReason =
  | 'spawn_failed'
  | 'sdk_missing'
  | 'auth_required'
  | 'agent_error'
  | 'no_models'
  | 'timeout';

export type AcpModelsResponse =
  | {
      ok: true;
      models: AcpModelEntry[];
      currentModelId: string | null;
      discoveredAt: number;
    }
  | {
      ok: false;
      reason: AcpModelsUnavailableReason;
      message: string | null;
      discoveredAt: number;
    };

export interface OpenCodeModelEntry {
  modelId: string;
  name: string;
}

export type OpenCodeModelsResponse =
  | {
      ok: true;
      models: OpenCodeModelEntry[];
      currentModelId: string | null;
      discoveredAt: number;
    }
  | {
      ok: false;
      reason:
        | 'spawn_failed'
        | 'sdk_missing'
        | 'auth_required'
        | 'agent_error'
        | 'no_models'
        | 'timeout';
      message: string | null;
      discoveredAt: number;
    };

export interface ExternalClaudeSession {
  id: string;
  source: 'claude-code';
  pid: number | null;
  ppid: number | null;
  isRunning: boolean;
  sessionId: string | null;
  cwd: string | null;
  projectId?: string | null;
  projectName: string | null;
  gitBranch: string | null;
  title: string;
  lastPrompt: string | null;
  command: string | null;
  startedAt: string | null;
  elapsedSeconds: number | null;
  updatedAt: string | null;
}

export interface ExternalClaudeTranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string | null;
  toolCalls?: ExternalClaudeTranscriptToolCall[];
}

export interface ExternalClaudeTranscriptToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  timestamp: string | null;
  author?: string;
}

export interface ExternalClaudeTranscript {
  sessionId: string;
  cwd: string | null;
  projectName: string | null;
  gitBranch: string | null;
  title: string;
  startedAt: string | null;
  updatedAt: string | null;
  messages: ExternalClaudeTranscriptMessage[];
}

export const systemApi = {
  // Deployment mode — 'team' when served by the central server (no co-located
  // Claude CLI; runner-only onboarding steps are skipped), 'standalone' when
  // served directly by an all-in-one runtime.
  bootstrap: () => request<{ mode: 'team' | 'standalone' }>('/bootstrap'),

  // Setup
  setupStatus: () =>
    request<{
      claudeCli: {
        available: boolean;
        path: string | null;
        error: string | null;
        version: string | null;
      };
      nativeGit: {
        loaded: boolean;
        disabled: boolean;
        rustAvailable: boolean;
        rustVersion: string | null;
        platform: string;
        canBuild: boolean;
      };
    }>('/setup/status'),

  // System
  getAvailableShells: () =>
    request<{
      shells: Array<{ id: string; label: string; path: string }>;
    }>('/system/shells'),
  listExternalClaudeSessions: (opts: { projectId?: string | null } = {}) => {
    const qs = opts.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : '';
    return request<{
      sessions: ExternalClaudeSession[];
      syncedThreadIds?: string[];
    }>(`/system/claude-code/external-sessions${qs}`);
  },
  getExternalClaudeTranscript: (sessionId: string) =>
    request<{ transcript: ExternalClaudeTranscript }>(
      `/system/claude-code/external-sessions/${encodeURIComponent(sessionId)}`,
    ),
  importExternalClaudeSession: (sessionId: string, body: { projectId?: string | null } = {}) =>
    request<{ imported: boolean; thread: Record<string, any> }>(
      `/system/claude-code/external-sessions/${encodeURIComponent(sessionId)}/import`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  dismissExternalClaudeSession: (sessionId: string) =>
    request<{ ok: boolean }>(
      `/system/claude-code/external-sessions/${encodeURIComponent(sessionId)}/dismiss`,
      { method: 'POST' },
    ),
  buildNativeGit: () => request<{ status: string }>('/system/build-native-git', { method: 'POST' }),

  // Dynamic ACP model catalog — one endpoint serves every provider whose
  // manifest declares `models.kind: 'dynamic'` (pi / cursor / opencode). The
  // runner spawns the provider's ACP CLI to read what it advertises.
  // Runner-installed (external) providers advertised by the user's runner
  // (provider-manifest-loader §3). The client merges these into the model picker.
  getProviders: () =>
    request<{
      providers: AdvertisedProvider[];
      activeBuiltins: string[] | null;
      availableProviders: string[] | null;
      hasRunner: boolean;
    }>('/providers'),

  // Install / remove a provider extension ON THE USER'S RUNNER (provider-install-ui).
  // Proxied by the server's /api/* tunnel to the runner. The install response
  // discloses the binary the provider will launch.
  installProvider: (body: { git?: string; path?: string; ref?: string; subdir?: string }) =>
    request<{
      ok: boolean;
      provider: {
        id: string;
        label: string;
        dirName: string;
        spawn: { command: string; args: string[] };
      };
    }>('/system/providers/install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeProvider: (id: string) =>
    request<{ ok: boolean; id: string }>('/system/providers/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  // Enable / disable a built-in ACP provider live on the runner (lean-core §4).
  // Session-scoped — FUNNY_PROVIDERS is the persisted source of truth.
  setBuiltinEnabled: (id: string, enabled: boolean) =>
    request<{ ok: boolean; id: string; active: string[] }>(
      `/system/providers/${enabled ? 'enable' : 'disable'}-builtin`,
      { method: 'POST', body: JSON.stringify({ id }) },
    ),

  getAcpModels: (provider: string, refresh = false) =>
    request<AcpModelsResponse>(`/system/${provider}/models${refresh ? '?refresh=1' : ''}`),

  // opencode dynamic model catalog (spawns opencode acp on the runner).
  getOpenCodeModels: (refresh = false) =>
    request<OpenCodeModelsResponse>(`/system/opencode/models${refresh ? '?refresh=1' : ''}`),

  // Files (internal editor)
  readFile: (path: string) =>
    request<{ content: string }>(`/files/read?path=${encodeURIComponent(path)}`),
  getFileBlame: (path: string) =>
    request<BlameResponse>(`/files/blame?path=${encodeURIComponent(path)}`),
  getFileHistory: (path: string) =>
    request<FileHistoryEntry[]>(`/files/history?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    request<{ ok: boolean }>('/files/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
};
