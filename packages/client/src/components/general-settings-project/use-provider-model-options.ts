import { useTranslation } from 'react-i18next';

import { useAcpModels } from '@/data/runner/hooks';
import { getModelOptions } from '@/lib/providers';

/**
 * The models a provider offers, as combobox options: the static registry plus,
 * for the dynamic catalogs (pi / cursor / opencode), what the agent advertises
 * at runtime (e.g. zai/glm-5.1) instead of just the `default` sentinel.
 */
export function useProviderModelOptions(provider: string): { value: string; label: string }[] {
  const { t } = useTranslation();
  const acpByProvider = useAcpModels();
  const base = getModelOptions(provider, t);
  const dynamic = acpByProvider[provider];
  if (dynamic?.status === 'ready') {
    const seen = new Set(base.map((o) => o.value));
    for (const m of dynamic.models) {
      if (seen.has(m.modelId)) continue;
      base.push({ value: m.modelId, label: m.name || m.modelId });
      seen.add(m.modelId);
    }
  }
  return base;
}
