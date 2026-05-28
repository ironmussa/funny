import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { createClientLogger } from '@/lib/client-logger';
import { useCursorModelsStore } from '@/stores/cursor-models-store';

const cursorLog = createClientLogger('PromptInputCursorModels');

export interface ModelGroup {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string }[];
  [key: string]: unknown;
}

/**
 * Merges cursor's runtime-discovered model catalog into the static unified
 * model groups. Surfaces fetch failures via Abbacchio so they show up in
 * observability. Mirrors `usePiPromptModels`.
 */
export function useCursorPromptModels(baseUnifiedModelGroups: ModelGroup[]): ModelGroup[] {
  const { t } = useTranslation();
  const cursorStatus = useCursorModelsStore((s) => s.status);
  const cursorModels = useCursorModelsStore((s) => s.models);
  const cursorReason = useCursorModelsStore((s) => s.reason);
  const cursorMessage = useCursorModelsStore((s) => s.message);
  const fetchCursorModels = useCursorModelsStore((s) => s.fetch);

  useEffect(() => {
    void fetchCursorModels();
  }, [fetchCursorModels]);

  const lastWarnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (cursorStatus !== 'error' || !cursorMessage) return;
    const key = `${cursorReason ?? 'unknown'}|${cursorMessage}`;
    if (lastWarnedRef.current === key) return;
    lastWarnedRef.current = key;
    cursorLog.warn('cursor model discovery failed', {
      reason: cursorReason ?? 'unknown',
      message: cursorMessage,
    });
  }, [cursorStatus, cursorReason, cursorMessage]);

  return useMemo(() => {
    return baseUnifiedModelGroups.map((group) => {
      if (group.provider !== 'cursor') return group;
      const defaultLabel =
        t('thread.model.cursorDefault') === 'thread.model.cursorDefault'
          ? 'Cursor (configured default)'
          : t('thread.model.cursorDefault');
      const items: { value: string; label: string }[] = [
        { value: 'cursor:default', label: defaultLabel },
      ];
      if (cursorStatus === 'ready' && cursorModels.length > 0) {
        for (const m of cursorModels) {
          items.push({ value: `cursor:${m.modelId}`, label: m.name || m.modelId });
        }
      } else if (cursorStatus === 'error') {
        const hint =
          cursorReason === 'auth_required'
            ? t('thread.model.cursorAuthRequired', 'Cursor: configurar (run `cursor-agent login`)')
            : cursorReason === 'sdk_missing'
              ? t('thread.model.cursorSdkMissing', 'Cursor: SDK no instalado')
              : cursorReason === 'no_models'
                ? t('thread.model.cursorNoModels', 'Cursor: no hay modelos configurados')
                : cursorReason === 'spawn_failed'
                  ? t('thread.model.cursorSpawnFailed', 'Cursor: no se pudo iniciar cursor-agent')
                  : cursorReason === 'timeout'
                    ? t('thread.model.cursorTimeout', 'Cursor: tiempo de espera agotado')
                    : t('thread.model.cursorError', 'Cursor: error de descubrimiento');
        items.push({ value: 'cursor:__configure__', label: hint });
      } else if (cursorStatus === 'loading') {
        items.push({
          value: 'cursor:__loading__',
          label: t('thread.model.cursorLoading', 'Cargando modelos…'),
        });
      }
      return { ...group, models: items };
    });
  }, [baseUnifiedModelGroups, cursorStatus, cursorModels, cursorReason, t]);
}
