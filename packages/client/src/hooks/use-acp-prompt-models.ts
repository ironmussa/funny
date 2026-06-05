import { DYNAMIC_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { createClientLogger } from '@/lib/client-logger';
import { useAcpModelsStore } from '@/stores/acp-models-store';

const log = createClientLogger('PromptInputAcpModels');

export interface ModelGroup {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string }[];
  [key: string]: unknown;
}

const DYNAMIC_PROVIDERS = new Set<string>(DYNAMIC_ACP_PROVIDER_IDS);

/**
 * Merges every dynamic-catalog ACP provider's runtime-discovered models into
 * the static unified model groups. Replaces the three near-identical
 * `use-{pi,cursor,opencode}-prompt-models` hooks: the provider list comes from
 * the manifest registry and the per-provider labels/i18n keys are derived
 * (`thread.model.${provider}${Suffix}`), so adding a dynamic provider needs no
 * new hook. Fetch failures surface via Abbacchio.
 */
export function useAcpPromptModels(baseUnifiedModelGroups: ModelGroup[]): ModelGroup[] {
  const { t } = useTranslation();
  const byProvider = useAcpModelsStore((s) => s.byProvider);
  const fetchModels = useAcpModelsStore((s) => s.fetch);

  // Discover each dynamic provider once (the store de-dupes via its cache window).
  useEffect(() => {
    for (const provider of DYNAMIC_ACP_PROVIDER_IDS) void fetchModels(provider);
  }, [fetchModels]);

  // Warn once per (provider, reason, message) on discovery failure.
  const lastWarnedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const provider of DYNAMIC_ACP_PROVIDER_IDS) {
      const st = byProvider[provider];
      if (!st || st.status !== 'error' || !st.message) continue;
      const key = `${st.reason ?? 'unknown'}|${st.message}`;
      if (lastWarnedRef.current[provider] === key) continue;
      lastWarnedRef.current[provider] = key;
      log.warn('acp model discovery failed', {
        provider,
        reason: st.reason ?? 'unknown',
        message: st.message,
      });
    }
  }, [byProvider]);

  return useMemo(() => {
    const tr = (key: string, fallback: string) => {
      const full = `thread.model.${key}`;
      const translated = t(full);
      return translated === full ? fallback : translated;
    };

    return baseUnifiedModelGroups.map((group) => {
      if (!DYNAMIC_PROVIDERS.has(group.provider)) return group;
      const provider = group.provider;
      const st = byProvider[provider];

      const defaultLabel = tr(`${provider}Default`, `${group.providerLabel} (configured default)`);
      const items: { value: string; label: string }[] = [
        { value: `${provider}:default`, label: defaultLabel },
      ];

      if (st?.status === 'ready' && st.models.length > 0) {
        for (const m of st.models) {
          items.push({ value: `${provider}:${m.modelId}`, label: m.name || m.modelId });
        }
      } else if (st?.status === 'error') {
        const hint =
          st.reason === 'auth_required'
            ? tr(`${provider}AuthRequired`, `${provider}: configurar (autenticar en el runner)`)
            : st.reason === 'sdk_missing'
              ? tr(`${provider}SdkMissing`, `${provider}: SDK no instalado`)
              : st.reason === 'no_models'
                ? tr(`${provider}NoModels`, `${provider}: no hay modelos configurados`)
                : st.reason === 'spawn_failed'
                  ? tr(`${provider}SpawnFailed`, `${provider}: no se pudo iniciar`)
                  : st.reason === 'timeout'
                    ? tr(`${provider}Timeout`, `${provider}: tiempo de espera agotado`)
                    : tr(`${provider}Error`, `${provider}: error de descubrimiento`);
        items.push({ value: `${provider}:__configure__`, label: hint });
      } else if (st?.status === 'loading') {
        items.push({
          value: `${provider}:__loading__`,
          label: tr(`${provider}Loading`, 'Cargando modelos…'),
        });
      }

      return { ...group, models: items };
    });
  }, [baseUnifiedModelGroups, byProvider, t]);
}
