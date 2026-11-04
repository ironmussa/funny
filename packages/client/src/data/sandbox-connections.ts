import { infraApi, type InfraConnection } from '@/lib/api/infra';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from './data-layer';
import { useDataQuery } from './hooks';
import { unwrapResult } from './query-client';
import { getDataLayer } from './runtime';

const log = createClientLogger('sandbox-connections');

const KEY = ['sandbox-connections'] as const;
const NO_CONNECTIONS: InfraConnection[] = [];

async function fetchSandboxConnections(): Promise<InfraConnection[]> {
  try {
    const { connections } = await unwrapResult(infraApi.listInfraConnections());
    return connections;
  } catch (error) {
    log.warn('failed to load sandbox connections', { error: (error as Error).message });
    throw error;
  }
}

/**
 * The user's sandbox provider connections (change thread-sandboxes). The
 * compose box reads them to offer "Sandbox" as a runtime; Settings >
 * Sandboxes refreshes them after adding or removing a connection. With
 * `enabled: false` the cached list is returned without requesting it.
 */
export function useSandboxConnections(options: { enabled?: boolean } = {}): {
  connections: InfraConnection[];
  loading: boolean;
} {
  const { data, isFetching } = useDataQuery({
    queryKey: KEY,
    queryFn: fetchSandboxConnections,
    enabled: options.enabled,
  });
  return { connections: data ?? NO_CONNECTIONS, loading: isFetching };
}

/** Refetch now. */
export function refreshSandboxConnections(layer: DataLayer = getDataLayer()): Promise<void> {
  return layer.queryClient
    .fetchQuery({ queryKey: KEY, queryFn: fetchSandboxConnections, staleTime: 0 })
    .then(
      () => undefined,
      () => undefined,
    );
}
