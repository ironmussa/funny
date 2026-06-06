import { create } from 'zustand';

import { systemApi, type OpenCodeModelEntry, type OpenCodeModelsResponse } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('opencode-models-store');

type Status = 'idle' | 'loading' | 'ready' | 'error';

export type OpenCodeUnavailableReason = Extract<OpenCodeModelsResponse, { ok: false }>['reason'];

interface OpenCodeModelsState {
  status: Status;
  models: OpenCodeModelEntry[];
  currentModelId: string | null;
  /** Reason returned by the runner when discovery failed. */
  reason: OpenCodeUnavailableReason | null;
  /** Optional human-readable detail to surface in the UI. */
  message: string | null;
  /** Timestamp of the last *successful* load (ms). 0 if never loaded. */
  loadedAt: number;
  fetch: (force?: boolean) => Promise<void>;
}

const STALE_MS = 60_000;

export const useOpenCodeModelsStore = create<OpenCodeModelsState>((set, get) => ({
  status: 'idle',
  models: [],
  currentModelId: null,
  reason: null,
  message: null,
  loadedAt: 0,

  fetch: async (force = false) => {
    const state = get();
    if (state.status === 'loading') return;
    // Honor the cache window for both successful and failed loads, so a missing
    // opencode install does not re-hit the runner on every PromptInput mount /
    // Strict Mode double-effect / HMR remount.
    if (
      !force &&
      (state.status === 'ready' || state.status === 'error') &&
      Date.now() - state.loadedAt < STALE_MS
    ) {
      return;
    }

    set({ status: 'loading' });
    const result = await systemApi.getOpenCodeModels(force);
    if (result.isErr()) {
      const message = result.error.message ?? 'Failed to fetch opencode models';
      if (state.reason !== 'agent_error' || state.message !== message) {
        log.warn('failed to load opencode models', { error: message });
      }
      set({
        status: 'error',
        reason: 'agent_error',
        message,
        loadedAt: Date.now(),
      });
      return;
    }

    const payload = result.value;
    if (payload.ok) {
      set({
        status: 'ready',
        models: payload.models,
        currentModelId: payload.currentModelId,
        reason: null,
        message: null,
        loadedAt: Date.now(),
      });
    } else {
      if (state.reason !== payload.reason) {
        log.info('opencode unavailable', { reason: payload.reason, message: payload.message });
      }
      set({
        status: 'error',
        models: [],
        currentModelId: null,
        reason: payload.reason,
        message: payload.message,
        loadedAt: Date.now(),
      });
    }
  },
}));
