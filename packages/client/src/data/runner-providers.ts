import type { AdvertisedProvider } from '@/lib/api/system';
import { systemApi } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from './data-layer';
import { useDataQuery } from './hooks';
import { unwrapResult } from './query-client';
import { getDataLayer } from './runtime';

const log = createClientLogger('runner-providers');

/** What the user's runner advertises (`GET /api/providers`). */
export interface RunnerProviders {
  /** External providers installed on the runner (provider-manifest-loader §3). */
  providers: AdvertisedProvider[];
  /** Active built-in ACP providers (lean-core). null = unknown: don't filter the picker. */
  activeBuiltins: string[] | null;
  /** Active providers that can actually run (model-picker-availability). null = not advertised. */
  availableProviders: string[] | null;
  /** Whether the user has any connected runner ("no runner" vs "didn't advertise"). */
  hasRunner: boolean;
}

const KEY = ['runner-providers'] as const;

const UNKNOWN: RunnerProviders = {
  providers: [],
  activeBuiltins: null,
  availableProviders: null,
  hasRunner: false,
};

async function fetchRunnerProviders(): Promise<RunnerProviders> {
  try {
    return await unwrapResult(systemApi.getProviders());
  } catch (error) {
    log.warn('failed to load runner providers', { error: (error as Error).message });
    throw error;
  }
}

/**
 * The runner's providers, cached for the default freshness period so the
 * model picker does not re-request on every mount. Unknown until loaded.
 */
export function useRunnerProviders(): RunnerProviders {
  const { data } = useDataQuery({ queryKey: KEY, queryFn: fetchRunnerProviders });
  return data ?? UNKNOWN;
}

/** Refetch now (after installing or removing a provider). */
export function refreshRunnerProviders(layer: DataLayer = getDataLayer()): Promise<void> {
  return layer.queryClient
    .fetchQuery({ queryKey: KEY, queryFn: fetchRunnerProviders, staleTime: 0 })
    .then(
      () => undefined,
      () => undefined,
    );
}

/**
 * Reflect a built-in toggle at once, before the server's heartbeat-driven
 * cache catches up.
 */
export function setActiveBuiltins(ids: string[], layer: DataLayer = getDataLayer()): void {
  layer.queryClient.setQueryData<RunnerProviders>(KEY, (prev) => ({
    ...(prev ?? UNKNOWN),
    activeBuiltins: ids,
  }));
}
