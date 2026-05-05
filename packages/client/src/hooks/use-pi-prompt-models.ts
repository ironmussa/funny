import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { createClientLogger } from '@/lib/client-logger';
import { usePiModelsStore } from '@/stores/pi-models-store';

const piLog = createClientLogger('PromptInputPiModels');

interface ModelGroup {
  provider: string;
  models: { value: string; label: string }[];
  [key: string]: unknown;
}

/**
 * Merges Pi's runtime-discovered model catalog into the static unified model
 * groups. Surfaces fetch failures via Abbacchio so they show up in
 * observability. Extracted from PromptInput so the parent doesn't import
 * the pi-models store or createClientLogger directly.
 */
export function usePiPromptModels(baseUnifiedModelGroups: ModelGroup[]): ModelGroup[] {
  const { t } = useTranslation();
  const piStatus = usePiModelsStore((s) => s.status);
  const piModels = usePiModelsStore((s) => s.models);
  const piReason = usePiModelsStore((s) => s.reason);
  const piMessage = usePiModelsStore((s) => s.message);
  const fetchPiModels = usePiModelsStore((s) => s.fetch);

  useEffect(() => {
    void fetchPiModels();
  }, [fetchPiModels]);

  useEffect(() => {
    if (piStatus === 'error' && piMessage) {
      piLog.warn('pi model discovery failed', {
        reason: piReason ?? 'unknown',
        message: piMessage,
      });
    }
  }, [piStatus, piReason, piMessage]);

  return useMemo(() => {
    return baseUnifiedModelGroups.map((group) => {
      if (group.provider !== 'pi') return group;
      const defaultLabel =
        t('thread.model.piDefault') === 'thread.model.piDefault'
          ? 'Pi (configured default)'
          : t('thread.model.piDefault');
      const items: { value: string; label: string }[] = [
        { value: 'pi:default', label: defaultLabel },
      ];
      if (piStatus === 'ready' && piModels.length > 0) {
        for (const m of piModels) {
          items.push({ value: `pi:${m.modelId}`, label: m.name || m.modelId });
        }
      } else if (piStatus === 'error') {
        const hint =
          piReason === 'auth_required'
            ? t('thread.model.piAuthRequired', 'Pi: configurar (run `pi auth`)')
            : piReason === 'sdk_missing'
              ? t('thread.model.piSdkMissing', 'Pi: SDK no instalado')
              : piReason === 'no_models'
                ? t('thread.model.piNoModels', 'Pi: no hay modelos configurados')
                : piReason === 'spawn_failed'
                  ? t('thread.model.piSpawnFailed', 'Pi: no se pudo iniciar pi-acp')
                  : piReason === 'timeout'
                    ? t('thread.model.piTimeout', 'Pi: tiempo de espera agotado')
                    : t('thread.model.piError', 'Pi: error de descubrimiento');
        items.push({ value: 'pi:__configure__', label: hint });
      } else if (piStatus === 'loading') {
        items.push({
          value: 'pi:__loading__',
          label: t('thread.model.piLoading', 'Cargando modelos…'),
        });
      }
      return { ...group, models: items };
    });
  }, [baseUnifiedModelGroups, piStatus, piModels, piReason, t]);
}
