import { DYNAMIC_MODEL_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { useMemo } from 'react';

import { useDataQueries, useDataQuery } from '../hooks';
import {
  acpModelQueries,
  IDLE_MODELS,
  runnerProvidersQuery,
  UNKNOWN_RUNNER_PROVIDERS,
  type ProviderModels,
  type RunnerProviders,
} from './queries';

/** React reads of the runner queries (`queries.ts`). Each fetches on mount when stale. */

const LOADING_MODELS: ProviderModels = { ...IDLE_MODELS, status: 'loading' };

/** The runner's providers; unknown until loaded, so the picker does not gate. */
export function useRunnerProviders(): RunnerProviders {
  const { data } = useDataQuery(runnerProvidersQuery);
  return data ?? UNKNOWN_RUNNER_PROVIDERS;
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
