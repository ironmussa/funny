import { create } from 'zustand';

import { systemApi, type AdvertisedProvider } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('runner-providers-store');

const STALE_MS = 60_000;

interface RunnerProvidersState {
  /** External providers advertised by the user's runner (provider-manifest-loader §3). */
  providers: AdvertisedProvider[];
  loadedAt: number;
  loading: boolean;
  fetch: (force?: boolean) => Promise<void>;
}

/**
 * Fetches the runner-installed (external) providers the server advertises for
 * this user from `GET /api/providers`. Cached with a stale window so the model
 * picker doesn't re-hit on every mount.
 */
export const useRunnerProvidersStore = create<RunnerProvidersState>((set, get) => ({
  providers: [],
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
    set({ providers: res.value.providers, loading: false, loadedAt: Date.now() });
  },
}));
