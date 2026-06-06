import { useEffect, useMemo } from 'react';

import { useRunnerProvidersStore } from '@/stores/runner-providers-store';

import type { ModelGroup } from './use-acp-prompt-models';

/**
 * Appends the user's runner-installed (external) providers to the model picker
 * groups (provider-manifest-loader §3.3). Each advertised provider becomes a
 * group keyed by its id; a static catalog lists its entries, a dynamic one
 * shows its configured default. The full model discovery for dynamic external
 * providers reuses the existing `/api/system/:provider/models` proxy and can be
 * layered on later — the provider is already selectable with its default.
 */
export function useRunnerProviderGroups(baseGroups: ModelGroup[]): ModelGroup[] {
  const providers = useRunnerProvidersStore((s) => s.providers);
  const fetch = useRunnerProvidersStore((s) => s.fetch);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return useMemo(() => {
    if (providers.length === 0) return baseGroups;
    const existing = new Set(baseGroups.map((g) => g.provider));
    const extra: ModelGroup[] = providers
      .filter((p) => !existing.has(p.id))
      .map((p) => {
        const models =
          p.models.kind === 'static' && p.models.entries && p.models.entries.length > 0
            ? p.models.entries.map((e) => ({ value: `${p.id}:${e.id}`, label: e.label }))
            : [
                {
                  value: `${p.id}:${p.models.defaultModel}`,
                  label: `${p.label} (configured default)`,
                },
              ];
        return { provider: p.id, providerLabel: p.label, models };
      });
    return extra.length > 0 ? [...baseGroups, ...extra] : baseGroups;
  }, [baseGroups, providers]);
}
