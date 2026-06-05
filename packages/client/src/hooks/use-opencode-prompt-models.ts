import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { createClientLogger } from '@/lib/client-logger';
import { useOpenCodeModelsStore } from '@/stores/opencode-models-store';

const opencodeLog = createClientLogger('PromptInputOpenCodeModels');

export interface ModelGroup {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string }[];
  [key: string]: unknown;
}

/**
 * Merges opencode's runtime-discovered model catalog into the static unified
 * model groups. Surfaces fetch failures via Abbacchio so they show up in
 * observability. Mirrors `useCursorPromptModels`.
 */
export function useOpenCodePromptModels(baseUnifiedModelGroups: ModelGroup[]): ModelGroup[] {
  const { t } = useTranslation();
  const opencodeStatus = useOpenCodeModelsStore((s) => s.status);
  const opencodeModels = useOpenCodeModelsStore((s) => s.models);
  const opencodeReason = useOpenCodeModelsStore((s) => s.reason);
  const opencodeMessage = useOpenCodeModelsStore((s) => s.message);
  const fetchOpenCodeModels = useOpenCodeModelsStore((s) => s.fetch);

  useEffect(() => {
    void fetchOpenCodeModels();
  }, [fetchOpenCodeModels]);

  const lastWarnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (opencodeStatus !== 'error' || !opencodeMessage) return;
    const key = `${opencodeReason ?? 'unknown'}|${opencodeMessage}`;
    if (lastWarnedRef.current === key) return;
    lastWarnedRef.current = key;
    opencodeLog.warn('opencode model discovery failed', {
      reason: opencodeReason ?? 'unknown',
      message: opencodeMessage,
    });
  }, [opencodeStatus, opencodeReason, opencodeMessage]);

  return useMemo(() => {
    return baseUnifiedModelGroups.map((group) => {
      if (group.provider !== 'opencode') return group;
      const defaultLabel =
        t('thread.model.opencodeDefault') === 'thread.model.opencodeDefault'
          ? 'opencode (configured default)'
          : t('thread.model.opencodeDefault');
      const items: { value: string; label: string }[] = [
        { value: 'opencode:default', label: defaultLabel },
      ];
      if (opencodeStatus === 'ready' && opencodeModels.length > 0) {
        for (const m of opencodeModels) {
          items.push({ value: `opencode:${m.modelId}`, label: m.name || m.modelId });
        }
      } else if (opencodeStatus === 'error') {
        const hint =
          opencodeReason === 'auth_required'
            ? t(
                'thread.model.opencodeAuthRequired',
                'opencode: configurar (run `opencode auth login`)',
              )
            : opencodeReason === 'sdk_missing'
              ? t('thread.model.opencodeSdkMissing', 'opencode: SDK no instalado')
              : opencodeReason === 'no_models'
                ? t('thread.model.opencodeNoModels', 'opencode: no hay modelos configurados')
                : opencodeReason === 'spawn_failed'
                  ? t('thread.model.opencodeSpawnFailed', 'opencode: no se pudo iniciar opencode')
                  : opencodeReason === 'timeout'
                    ? t('thread.model.opencodeTimeout', 'opencode: tiempo de espera agotado')
                    : t('thread.model.opencodeError', 'opencode: error de descubrimiento');
        items.push({ value: 'opencode:__configure__', label: hint });
      } else if (opencodeStatus === 'loading') {
        items.push({
          value: 'opencode:__loading__',
          label: t('thread.model.opencodeLoading', 'Cargando modelos…'),
        });
      }
      return { ...group, models: items };
    });
  }, [baseUnifiedModelGroups, opencodeStatus, opencodeModels, opencodeReason, t]);
}
