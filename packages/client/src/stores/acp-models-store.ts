import { create } from 'zustand';

import {
  systemApi,
  type AcpModelEntry,
  type AcpModelsResponse,
  type AcpModelsUnavailableReason,
} from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('acp-models-store');

type Status = 'idle' | 'loading' | 'ready' | 'error';

export interface ProviderModelsState {
  status: Status;
  models: AcpModelEntry[];
  currentModelId: string | null;
  reason: AcpModelsUnavailableReason | null;
  message: string | null;
  /** Timestamp of the last load attempt (ms). 0 if never loaded. */
  loadedAt: number;
}

const EMPTY: ProviderModelsState = {
  status: 'idle',
  models: [],
  currentModelId: null,
  reason: null,
  message: null,
  loadedAt: 0,
};

interface AcpModelsStore {
  /** Per-provider discovery state, keyed by provider id. */
  byProvider: Record<string, ProviderModelsState>;
  fetch: (provider: string, force?: boolean) => Promise<void>;
}

const STALE_MS = 60_000;

/**
 * One store for every dynamic-catalog ACP provider (pi / cursor / opencode),
 * keyed by provider id — replaces the three byte-identical per-provider stores.
 * The provider-specific UI (labels, i18n) is derived in
 * `use-acp-prompt-models.ts` from the manifest set.
 */
export const useAcpModelsStore = create<AcpModelsStore>((set, get) => ({
  byProvider: {},

  fetch: async (provider, force = false) => {
    const cur = get().byProvider[provider] ?? EMPTY;
    if (cur.status === 'loading') return;
    // Honor the cache window for both successful and failed loads, so a missing
    // CLI does not re-hit the runner on every PromptInput mount / Strict-Mode
    // double-effect / HMR remount.
    if (
      !force &&
      (cur.status === 'ready' || cur.status === 'error') &&
      Date.now() - cur.loadedAt < STALE_MS
    ) {
      return;
    }

    const patch = (next: ProviderModelsState) =>
      set((s) => ({ byProvider: { ...s.byProvider, [provider]: next } }));

    patch({ ...cur, status: 'loading' });
    const result = await systemApi.getAcpModels(provider, force);

    if (result.isErr()) {
      const message = result.error.message ?? `Failed to fetch ${provider} models`;
      if (cur.reason !== 'agent_error' || cur.message !== message) {
        log.warn('failed to load acp models', { provider, error: message });
      }
      patch({ ...EMPTY, status: 'error', reason: 'agent_error', message, loadedAt: Date.now() });
      return;
    }

    const payload: AcpModelsResponse = result.value;
    if (payload.ok) {
      patch({
        status: 'ready',
        models: payload.models,
        currentModelId: payload.currentModelId,
        reason: null,
        message: null,
        loadedAt: Date.now(),
      });
    } else {
      if (cur.reason !== payload.reason) {
        log.info('acp provider unavailable', {
          provider,
          reason: payload.reason,
          message: payload.message,
        });
      }
      patch({
        ...EMPTY,
        status: 'error',
        reason: payload.reason,
        message: payload.message,
        loadedAt: Date.now(),
      });
    }
  },
}));
