import { create } from 'zustand';

import { api } from '@/lib/api';
import type { OrchestratorRun } from '@/lib/api/orchestrator';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('orchestrator-store');

export interface OrchestratorState {
  runsByThread: Record<string, OrchestratorRun>;
  loading: boolean;
  refreshing: boolean;
  lastError: string | null;

  loadRuns: () => Promise<void>;
  refresh: () => Promise<void>;

  // WS event handlers — partial updates that merge into the run row.
  handleClaimed: (threadId: string, data: { userId?: string; attempt?: number }) => void;
  handleDispatched: (threadId: string, data: { pipelineRunId?: string }) => void;
  handleRetryQueued: (
    threadId: string,
    data: { attempt?: number; dueAtMs?: number; error?: string },
  ) => void;
  handleReleased: (threadId: string) => void;
}

function patchRun(
  prev: OrchestratorRun | undefined,
  threadId: string,
  patch: Partial<OrchestratorRun>,
): OrchestratorRun {
  const now = Date.now();
  if (!prev) {
    return {
      threadId,
      pipelineRunId: null,
      attempt: 0,
      nextRetryAtMs: null,
      lastEventAtMs: now,
      lastError: null,
      claimedAtMs: now,
      userId: '',
      tokensTotal: 0,
      updatedAtMs: now,
      ...patch,
    };
  }
  return { ...prev, ...patch, lastEventAtMs: now, updatedAtMs: now };
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  runsByThread: {},
  loading: false,
  refreshing: false,
  lastError: null,

  loadRuns: async () => {
    set({ loading: true, lastError: null });
    const result = await api.listOrchestratorRuns();
    result.match(
      (response) => {
        const byThread: Record<string, OrchestratorRun> = {};
        for (const r of response.runs) byThread[r.threadId] = r;
        set({ runsByThread: byThread, loading: false });
      },
      (error) => {
        log.warn('Failed to load orchestrator runs', { error: error.message });
        set({ loading: false, lastError: error.message });
      },
    );
  },

  refresh: async () => {
    if (get().refreshing) return;
    set({ refreshing: true, lastError: null });
    const result = await api.refreshOrchestrator();
    result.match(
      () => {
        // Re-pull canonical state after a tick.
        void get().loadRuns();
      },
      (error) => {
        log.warn('Failed to refresh orchestrator', { error: error.message });
        set({ lastError: error.message });
      },
    );
    set({ refreshing: false });
  },

  handleClaimed: (threadId, data) =>
    set((state) => ({
      runsByThread: {
        ...state.runsByThread,
        [threadId]: patchRun(state.runsByThread[threadId], threadId, {
          userId: data.userId ?? state.runsByThread[threadId]?.userId ?? '',
          attempt: data.attempt ?? state.runsByThread[threadId]?.attempt ?? 0,
          claimedAtMs: state.runsByThread[threadId]?.claimedAtMs ?? Date.now(),
          lastError: null,
          nextRetryAtMs: null,
        }),
      },
    })),

  handleDispatched: (threadId, data) =>
    set((state) => ({
      runsByThread: {
        ...state.runsByThread,
        [threadId]: patchRun(state.runsByThread[threadId], threadId, {
          pipelineRunId: data.pipelineRunId ?? null,
        }),
      },
    })),

  handleRetryQueued: (threadId, data) =>
    set((state) => ({
      runsByThread: {
        ...state.runsByThread,
        [threadId]: patchRun(state.runsByThread[threadId], threadId, {
          attempt: data.attempt ?? state.runsByThread[threadId]?.attempt ?? 0,
          nextRetryAtMs: data.dueAtMs ?? null,
          lastError: data.error ?? null,
        }),
      },
    })),

  handleReleased: (threadId) =>
    set((state) => {
      if (!state.runsByThread[threadId]) return state;
      const { [threadId]: _, ...rest } = state.runsByThread;
      return { runsByThread: rest };
    }),
}));
