import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAcpPromptModels } from '@/hooks/use-acp-prompt-models';
import { useRunnerProviderGroups } from '@/hooks/use-runner-provider-groups';
import { getUnifiedModelOptions } from '@/lib/providers';

/**
 * Static registry models, plus the runtime-discovered catalogs of every
 * dynamic-catalog ACP provider (pi / cursor / opencode), plus the user's
 * runner-installed external providers (provider-manifest-loader §3), grouped
 * for the prompt model picker and General Settings visibility UI.
 */
export function useUnifiedPromptModelGroups() {
  const { t } = useTranslation();
  const baseUnifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);
  const withAcp = useAcpPromptModels(baseUnifiedModelGroups);
  return useRunnerProviderGroups(withAcp);
}
