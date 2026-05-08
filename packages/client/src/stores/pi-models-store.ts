import { create } from 'zustand';

import { systemApi, type PiModelEntry, type PiModelsResponse } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('pi-models-store');

type Status = 'idle' | 'loading' | 'ready' | 'error';

export type PiUnavailableReason = Extract<PiModelsResponse, { ok: false }>['reason'];

interface PiModelsState {
  status: Status;
  models: PiModelEntry[];
  currentModelId: string | null;
  /** Reason returned by the runner when discovery failed. */
  reason: PiUnavailableReason | null;
  /** Optional human-readable detail to surface in the UI. */
  message: string | null;
  /** Timestamp of the last *successful* load (ms). 0 if never loaded. */
  loadedAt: number;
  /** Whether the user clicked the configure-pi help link / dismissed banner. */
  fetch: (force?: boolean) => Promise<void>;
}

const STALE_MS = 60_000;

export const usePiModelsStore = create<PiModelsState>((set, get) => ({
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
    // Pi install does not re-hit the runner on every PromptInput mount / Strict
    // Mode double-effect / HMR remount.
    if (
      !force &&
      (state.status === 'ready' || state.status === 'error') &&
      Date.now() - state.loadedAt < STALE_MS
    ) {
      return;
    }

    set({ status: 'loading' });
    const result = await systemApi.getPiModels(force);
    if (result.isErr()) {
      const message = result.error.message ?? 'Failed to fetch pi models';
      if (state.reason !== 'agent_error' || state.message !== message) {
        log.warn('failed to load pi models', { error: message });
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
        log.info('pi unavailable', { reason: payload.reason, message: payload.message });
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
