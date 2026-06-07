import { create } from 'zustand';

import { systemApi, type AdvertisedProvider } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('runner-providers-store');

const STALE_MS = 60_000;

interface RunnerProvidersState {
  /** External providers advertised by the user's runner (provider-manifest-loader §3). */
  providers: AdvertisedProvider[];
  /** Active built-in ACP providers on the runner (lean-core). null = unknown
   *  (don't filter the picker — no regression). */
  activeBuiltins: string[] | null;
  loadedAt: number;
  loading: boolean;
  fetch: (force?: boolean) => Promise<void>;
  /** Optimistically set the active built-in set (e.g. after a live toggle, so
   *  the picker updates before the server's heartbeat-driven cache catches up). */
  setActiveBuiltins: (ids: string[]) => void;
}

/**
 * Fetches the runner-installed (external) providers the server advertises for
 * this user from `GET /api/providers`. Cached with a stale window so the model
 * picker doesn't re-hit on every mount.
 */
export const useRunnerProvidersStore = create<RunnerProvidersState>((set, get) => ({
  providers: [],
  activeBuiltins: null,
  loadedAt: 0,
  loading: false,

  fetch: async (force = false) => {
    const s = get();
    if (s.loading) return;
    if (!force && s.loadedAt && Date.now() - s.loadedAt < STALE_MS) return;

    set({ loading: true });
    const res = await systemApi.getProviders();
    if (res.isErr()) {
      log.warn('failed to load runner providers', { error: res.error.message });
      set({ loading: false, loadedAt: Date.now() });
      return;
    }
    set({
      providers: res.value.providers,
      activeBuiltins: res.value.activeBuiltins,
      loading: false,
      loadedAt: Date.now(),
    });
  },

  setActiveBuiltins: (ids: string[]) => set({ activeBuiltins: ids }),
}));
