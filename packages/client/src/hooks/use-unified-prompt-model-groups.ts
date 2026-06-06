import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useCursorPromptModels } from '@/hooks/use-cursor-prompt-models';
import { useOpenCodePromptModels } from '@/hooks/use-opencode-prompt-models';
import { usePiPromptModels } from '@/hooks/use-pi-prompt-models';
import { getUnifiedModelOptions } from '@/lib/providers';

/**
 * Static registry models plus runtime-discovered Pi, Cursor and opencode
 * catalogs, grouped for the prompt model picker and General Settings
 * visibility UI.
 */
export function useUnifiedPromptModelGroups() {
  const { t } = useTranslation();
  const baseUnifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);
  const piUnifiedModelGroups = usePiPromptModels(baseUnifiedModelGroups);
  const cursorUnifiedModelGroups = useCursorPromptModels(piUnifiedModelGroups);
  return useOpenCodePromptModels(cursorUnifiedModelGroups);
}
