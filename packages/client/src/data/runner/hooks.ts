import { DYNAMIC_MODEL_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { useMemo } from 'react';

import type { InfraConnection, ProjectSandboxSettings, SandboxProviderInfo } from '@/lib/api/infra';

import { useDataQueries, useDataQuery } from '../hooks';
import {
  acpModelQueries,
  IDLE_MODELS,
  projectSandboxQuery,
  runnerProvidersQuery,
  sandboxConnectionsQuery,
  sandboxProvidersQuery,
  UNKNOWN_RUNNER_PROVIDERS,
  type ProviderModels,
  type RunnerProviders,
} from './queries';

/** React reads of the runner queries (`queries.ts`). Each fetches on mount when stale. */

const NO_CONNECTIONS: InfraConnection[] = [];
const NO_PROVIDERS: SandboxProviderInfo[] = [];
const LOADING_MODELS: ProviderModels = { ...IDLE_MODELS, status: 'loading' };

/** The runner's providers; unknown until loaded, so the picker does not gate. */
export function useRunnerProviders(): RunnerProviders {
  const { data } = useDataQuery(runnerProvidersQuery);
  return data ?? UNKNOWN_RUNNER_PROVIDERS;
}

/**
 * The user's sandbox provider connections. With `enabled: false` the cached
 * list is returned without requesting it.
 */
export function useSandboxConnections(options: { enabled?: boolean } = {}): {
  connections: InfraConnection[];
  loading: boolean;
} {
  const { data, isFetching } = useDataQuery({ ...sandboxConnectionsQuery, ...options });
  return { connections: data ?? NO_CONNECTIONS, loading: isFetching };
}

/** Registered sandbox providers with their sizes. */
export function useSandboxProviders(): SandboxProviderInfo[] {
  const { data } = useDataQuery(sandboxProvidersQuery);
  return data ?? NO_PROVIDERS;
}

export interface ProjectSandbox {
  settings: ProjectSandboxSettings;
  /** The configured connection; missing while connections load. */
  connection: InfraConnection | undefined;
}

/**
 * The current user's sandbox for a project (change project-sandboxes), with
 * its connection. `null` when none is configured or there is no project.
 */
export function useProjectSandbox(projectId: string | null | undefined): {
  sandbox: ProjectSandbox | null;
  loading: boolean;
} {
  const query = projectSandboxQuery(projectId ?? '');
  const { data, isFetching } = useDataQuery({ ...query, enabled: !!projectId });
  // Always enabled: the observer is shared per key, so readers must agree on options.
  const { connections } = useSandboxConnections();
  const sandbox = useMemo(
    () =>
      projectId && data
        ? { settings: data, connection: connections.find((c) => c.id === data.connectionId) }
        : null,
    [projectId, data, connections],
  );
  return { sandbox, loading: isFetching };
}

/** Discovery state of every dynamic ACP provider, keyed by provider id. */
export function useAcpModels(): Record<string, ProviderModels> {
  const results = useDataQueries(acpModelQueries);
  return useMemo(() => {
    const byProvider: Record<string, ProviderModels> = {};
    DYNAMIC_MODEL_PROVIDER_IDS.forEach((provider, i) => {
      const result = results[i];
      byProvider[provider] = result?.data ?? (result?.isFetching ? LOADING_MODELS : IDLE_MODELS);
    });
    return byProvider;
  }, [results]);
}
