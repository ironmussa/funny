import { request } from './_core';

export interface PiModelEntry {
  modelId: string;
  name: string;
}

export type PiModelsResponse =
  | {
      ok: true;
      models: PiModelEntry[];
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

export interface CursorModelEntry {
  modelId: string;
  name: string;
}

export type CursorModelsResponse =
  | {
      ok: true;
      models: CursorModelEntry[];
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

export const systemApi = {
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
  buildNativeGit: () => request<{ status: string }>('/system/build-native-git', { method: 'POST' }),

  // Pi dynamic model catalog (spawns pi-acp on the runner to read what pi advertises).
  getPiModels: (refresh = false) =>
    request<PiModelsResponse>(`/system/pi/models${refresh ? '?refresh=1' : ''}`),

  // Cursor dynamic model catalog (spawns cursor-agent acp on the runner).
  getCursorModels: (refresh = false) =>
    request<CursorModelsResponse>(`/system/cursor/models${refresh ? '?refresh=1' : ''}`),

  // opencode dynamic model catalog (spawns opencode acp on the runner).
  getOpenCodeModels: (refresh = false) =>
    request<OpenCodeModelsResponse>(`/system/opencode/models${refresh ? '?refresh=1' : ''}`),

  // Files (internal editor)
  readFile: (path: string) =>
    request<{ content: string }>(`/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    request<{ ok: boolean }>('/files/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
};
