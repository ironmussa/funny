import type { Watcher } from '@funny/shared';
import { create } from 'zustand';

import { watchersApi } from '@/lib/api/watchers';
import { createClientLogger } from '@/lib/client-logger';
import { useAuthStore } from '@/stores/auth-store';

const log = createClientLogger('watcher-store');

interface WatcherState {
  /** Every watcher the user owns, keyed by id (cross-thread). */
  watchersById: Record<string, Watcher>;

  loadWatchers: () => Promise<void>;
  cancelWatcher: (id: string) => Promise<void>;

  /** WS handler — applied for every watcher:* event (create/fire/reschedule/expire/cancel). */
  upsert: (watcher: Watcher) => void;
}

export const useWatcherStore = create<WatcherState>((set, get) => ({
  watchersById: {},

  loadWatchers: async () => {
    // WS events can arrive during the login/logout window; skip when no session.
    if (!useAuthStore.getState().isAuthenticated) return;
    const result = await watchersApi.listWatchers();
    result.match(
      (watchers) => set({ watchersById: Object.fromEntries(watchers.map((w) => [w.id, w])) }),
      (error) => log.warn('Failed to load watchers', { error: error.message }),
    );
  },

  cancelWatcher: async (id) => {
    const prev = get().watchersById[id];
    // Optimistic — the acting client reflects the cancel immediately.
    if (prev) {
      set((s) => ({ watchersById: { ...s.watchersById, [id]: { ...prev, status: 'cancelled' } } }));
    }
    const result = await watchersApi.cancelWatcher(id);
    result.match(
      (updated) => set((s) => ({ watchersById: { ...s.watchersById, [updated.id]: updated } })),
      (error) => {
        log.warn('Failed to cancel watcher', { error: error.message });
        if (prev) set((s) => ({ watchersById: { ...s.watchersById, [id]: prev } })); // rollback
      },
    );
  },

  upsert: (watcher) => set((s) => ({ watchersById: { ...s.watchersById, [watcher.id]: watcher } })),
}));
