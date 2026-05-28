import { create } from 'zustand';

import { systemApi, type CursorModelEntry, type CursorModelsResponse } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('cursor-models-store');

type Status = 'idle' | 'loading' | 'ready' | 'error';

export type CursorUnavailableReason = Extract<CursorModelsResponse, { ok: false }>['reason'];

interface CursorModelsState {
  status: Status;
  models: CursorModelEntry[];
  currentModelId: string | null;
  /** Reason returned by the runner when discovery failed. */
  reason: CursorUnavailableReason | null;
  /** Optional human-readable detail to surface in the UI. */
  message: string | null;
  /** Timestamp of the last *successful* load (ms). 0 if never loaded. */
  loadedAt: number;
  fetch: (force?: boolean) => Promise<void>;
}

const STALE_MS = 60_000;

export const useCursorModelsStore = create<CursorModelsState>((set, get) => ({
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
    // cursor install does not re-hit the runner on every PromptInput mount /
    // Strict Mode double-effect / HMR remount.
    if (
      !force &&
      (state.status === 'ready' || state.status === 'error') &&
      Date.now() - state.loadedAt < STALE_MS
    ) {
      return;
    }

    set({ status: 'loading' });
    const result = await systemApi.getCursorModels(force);
    if (result.isErr()) {
      const message = result.error.message ?? 'Failed to fetch cursor models';
      if (state.reason !== 'agent_error' || state.message !== message) {
        log.warn('failed to load cursor models', { error: message });
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
        log.info('cursor unavailable', { reason: payload.reason, message: payload.message });
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
