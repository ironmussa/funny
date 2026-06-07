import { KNOWN_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { useEffect, useMemo } from 'react';

import { useRunnerProvidersStore } from '@/stores/runner-providers-store';

import type { ModelGroup } from './use-acp-prompt-models';

/** Built-in ACP providers that lean-core can gate off (claude/deepagent/llm-api stay). */
const BUILTIN_ACP = new Set<string>(KNOWN_ACP_PROVIDER_IDS);

/**
 * Reconciles the model picker with the user's runner:
 *  - hides built-in ACP providers the runner has gated off (lean-core §3.4) —
 *    only when the runner advertises an active set (`activeBuiltins != null`);
 *    absent = no filtering (no regression).
 *  - appends the runner-installed external providers (provider-manifest-loader
 *    §3.3): static catalog → its entries, dynamic → its configured default.
 */
export function useRunnerProviderGroups(baseGroups: ModelGroup[]): ModelGroup[] {
  const providers = useRunnerProvidersStore((s) => s.providers);
  const activeBuiltins = useRunnerProvidersStore((s) => s.activeBuiltins);
  const fetch = useRunnerProvidersStore((s) => s.fetch);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return useMemo(() => {
    // 1. Hide gated-off built-in ACP providers (lean-core).
    const activeSet = activeBuiltins ? new Set(activeBuiltins) : null;
    const visible = activeSet
      ? baseGroups.filter((g) => !BUILTIN_ACP.has(g.provider) || activeSet.has(g.provider))
      : baseGroups;

    // 2. Append the runner's external providers.
    if (providers.length === 0) return visible;
    const existing = new Set(visible.map((g) => g.provider));
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
    return extra.length > 0 ? [...visible, ...extra] : visible;
  }, [baseGroups, providers, activeBuiltins]);
}
