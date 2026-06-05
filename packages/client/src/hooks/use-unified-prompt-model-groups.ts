import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAcpPromptModels } from '@/hooks/use-acp-prompt-models';
import { getUnifiedModelOptions } from '@/lib/providers';

/**
 * Static registry models plus the runtime-discovered catalogs of every
 * dynamic-catalog ACP provider (pi / cursor / opencode), grouped for the prompt
 * model picker and General Settings visibility UI. The dynamic providers come
 * from the manifest registry — see `useAcpPromptModels`.
 */
export function useUnifiedPromptModelGroups() {
  const { t } = useTranslation();
  const baseUnifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);
  return useAcpPromptModels(baseUnifiedModelGroups);
}
