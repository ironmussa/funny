import { create } from 'zustand';

import { infraApi, type InfraConnection } from '@/lib/api/infra';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('sandbox-connections-store');

const STALE_MS = 60_000;

interface SandboxConnectionsState {
  /** The user's sandbox provider connections (change thread-sandboxes). */
  connections: InfraConnection[];
  loadedAt: number;
  loading: boolean;
  fetch: (force?: boolean) => Promise<void>;
}

/**
 * Cached list of the user's sandbox provider connections. The compose box reads
 * it to offer "Sandbox" as a runtime; Settings > Sandboxes refreshes it after
 * adding or removing a connection.
 */
export const useSandboxConnectionsStore = create<SandboxConnectionsState>((set, get) => ({
  connections: [],
  loadedAt: 0,
  loading: false,

  fetch: async (force = false) => {
    const s = get();
    if (s.loading) return;
    if (!force && s.loadedAt && Date.now() - s.loadedAt < STALE_MS) return;

    set({ loading: true });
    const res = await infraApi.listInfraConnections();
    if (res.isErr()) {
      log.warn('failed to load sandbox connections', { error: res.error.message });
      set({ loading: false, loadedAt: Date.now() });
      return;
    }
    set({ connections: res.value.connections, loading: false, loadedAt: Date.now() });
  },
}));
