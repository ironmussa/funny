import type { AdvertisedProvider } from '@funny/shared/runner-protocol';

import { request } from './_core';

export type { AdvertisedProvider };

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

  // Dynamic ACP model catalog — one endpoint serves every provider whose
  // manifest declares `models.kind: 'dynamic'` (pi / cursor / opencode). The
  // runner spawns the provider's ACP CLI to read what it advertises.
  // Runner-installed (external) providers advertised by the user's runner
  // (provider-manifest-loader §3). The client merges these into the model picker.
  getProviders: () =>
    request<{ providers: AdvertisedProvider[]; activeBuiltins: string[] | null }>('/providers'),

  // Install / remove a provider extension ON THE USER'S RUNNER (provider-install-ui).
  // Proxied by the server's /api/* tunnel to the runner. The install response
  // discloses the binary the provider will launch.
  installProvider: (body: { git?: string; path?: string; ref?: string; subdir?: string }) =>
    request<{
      ok: boolean;
      provider: { id: string; label: string; dirName: string; spawn: { command: string; args: string[] } };
    }>('/system/providers/install', { method: 'POST', body: JSON.stringify(body) }),

  removeProvider: (id: string) =>
    request<{ ok: boolean; id: string }>('/system/providers/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  getAcpModels: (provider: string, refresh = false) =>
    request<AcpModelsResponse>(`/system/${provider}/models${refresh ? '?refresh=1' : ''}`),

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
