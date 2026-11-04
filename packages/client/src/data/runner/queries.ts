import { DYNAMIC_MODEL_PROVIDER_IDS } from '@funny/shared/provider-manifests';

import { infraApi, type InfraConnection } from '@/lib/api/infra';
import {
  systemApi,
  type AcpModelEntry,
  type AcpModelsUnavailableReason,
  type AdvertisedProvider,
} from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * Request-shaped data the user's runner advertises, as shared `QueryClient`
 * queries (no collection: none of it has per-row writes). React reads it
 * through `hooks.ts`; this module owns keys, fetchers and writes.
 */

const log = createClientLogger('runner-queries');

function warnAndRethrow(what: string) {
  return (error: unknown): never => {
    log.warn(`failed to load ${what}`, { error: (error as Error).message });
    throw error;
  };
}

/** Refetch a query now, ignoring its freshness; failures stay in the query state. */
function refetch(
  layer: DataLayer,
  query: { queryKey: readonly unknown[]; queryFn: () => unknown },
) {
  return layer.queryClient.fetchQuery({ ...query, staleTime: 0 }).then(
    () => undefined,
    () => undefined,
  );
}

// ── Runner providers (`GET /api/providers`) ─────────────────

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

export const UNKNOWN_RUNNER_PROVIDERS: RunnerProviders = {
  providers: [],
  activeBuiltins: null,
  availableProviders: null,
  hasRunner: false,
};

export const runnerProvidersQuery = {
  queryKey: ['runner-providers'] as const,
  queryFn: (): Promise<RunnerProviders> =>
    unwrapResult(systemApi.getProviders()).catch(warnAndRethrow('runner providers')),
};

/** Refetch now (after installing or removing a provider). */
export function refreshRunnerProviders(layer: DataLayer = getDataLayer()): Promise<void> {
  return refetch(layer, runnerProvidersQuery);
}

/** Reflect a built-in toggle at once, before the server's heartbeat-driven cache catches up. */
export function setActiveBuiltins(ids: string[], layer: DataLayer = getDataLayer()): void {
  layer.queryClient.setQueryData<RunnerProviders>(runnerProvidersQuery.queryKey, (prev) => ({
    ...(prev ?? UNKNOWN_RUNNER_PROVIDERS),
    activeBuiltins: ids,
  }));
}

// ── Sandbox connections (change thread-sandboxes) ───────────

export const sandboxConnectionsQuery = {
  queryKey: ['sandbox-connections'] as const,
  queryFn: (): Promise<InfraConnection[]> =>
    unwrapResult(infraApi.listInfraConnections())
      .then((r) => r.connections)
      .catch(warnAndRethrow('sandbox connections')),
};

/** Refetch now (Settings > Sandboxes, after adding or removing a connection). */
export function refreshSandboxConnections(layer: DataLayer = getDataLayer()): Promise<void> {
  return refetch(layer, sandboxConnectionsQuery);
}

// ── Dynamic ACP model catalogs (pi, cursor, opencode) ───────

/**
 * One provider's discovery state. A provider that cannot list its models
 * resolves to `error` instead of failing, so a missing CLI is cached for the
 * freshness period like a success and does not re-hit the runner on every
 * prompt mount.
 */
export interface ProviderModels {
  status: 'idle' | 'loading' | 'ready' | 'error';
  models: AcpModelEntry[];
  currentModelId: string | null;
  reason: AcpModelsUnavailableReason | null;
  message: string | null;
}

export const IDLE_MODELS: ProviderModels = {
  status: 'idle',
  models: [],
  currentModelId: null,
  reason: null,
  message: null,
};

async function fetchProviderModels(provider: string): Promise<ProviderModels> {
  const result = await systemApi.getAcpModels(provider);
  if (result.isErr()) {
    const message = result.error.message ?? `Failed to fetch ${provider} models`;
    return { ...IDLE_MODELS, status: 'error', reason: 'agent_error', message };
  }
  const payload = result.value;
  if (!payload.ok) {
    return { ...IDLE_MODELS, status: 'error', reason: payload.reason, message: payload.message };
  }
  return {
    status: 'ready',
    models: payload.models,
    currentModelId: payload.currentModelId,
    reason: null,
    message: null,
  };
}

/** One query per dynamic provider, in `DYNAMIC_MODEL_PROVIDER_IDS` order. */
export const acpModelQueries = DYNAMIC_MODEL_PROVIDER_IDS.map((provider) => ({
  queryKey: ['acp-models', provider] as const,
  queryFn: () => fetchProviderModels(provider),
}));
