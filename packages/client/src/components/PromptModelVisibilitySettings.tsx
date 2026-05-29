import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useUnifiedPromptModelGroups } from '@/hooks/use-unified-prompt-model-groups';
import { isPromptModelConfigurable } from '@/lib/providers';
import { useSettingsStore } from '@/stores/settings-store';

interface PromptModelVisibilitySettingsProps {
  /** Hide the inner title/description when the parent page already shows them. */
  showHeader?: boolean;
}

export function PromptModelVisibilitySettings({
  showHeader = true,
}: PromptModelVisibilitySettingsProps) {
  const { t } = useTranslation();
  const modelGroups = useUnifiedPromptModelGroups();
  const { hiddenPromptModels, setPromptModelVisible } = useSettingsStore(
    useShallow((s) => ({
      hiddenPromptModels: s.hiddenPromptModels,
      setPromptModelVisible: s.setPromptModelVisible,
    })),
  );
  const hiddenSet = new Set(hiddenPromptModels);

  // Only keep providers that have at least one user-toggleable model.
  const configurableGroups = useMemo(
    () =>
      modelGroups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => isPromptModelConfigurable(model.value)),
        }))
        .filter((group) => group.models.length > 0),
    [modelGroups],
  );

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const activeProvider =
    selectedProvider && configurableGroups.some((g) => g.provider === selectedProvider)
      ? selectedProvider
      : (configurableGroups[0]?.provider ?? null);
  const activeGroup = configurableGroups.find((g) => g.provider === activeProvider) ?? null;

  const saveVisibility = useCallback(
    (combinedKey: string, visible: boolean) => {
      setPromptModelVisible(combinedKey, visible);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setPromptModelVisible, t],
  );

  return (
    <div className="px-4 py-3.5">
      {showHeader && (
        <>
          <p className="text-sm font-medium text-foreground">
            {t('settings.promptModelVisibility')}
          </p>
          <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
            {t('settings.promptModelVisibilityDesc')}
          </p>
        </>
      )}

      <Select
        value={activeProvider ?? undefined}
        onValueChange={(value) => setSelectedProvider(value)}
      >
        <SelectTrigger className="w-full" data-testid="settings-prompt-model-provider">
          <SelectValue placeholder={t('settings.promptModelVisibilityProvider')} />
        </SelectTrigger>
        <SelectContent>
          {configurableGroups.map((group) => (
            <SelectItem
              key={group.provider}
              value={group.provider}
              data-testid={`settings-prompt-model-provider-${group.provider}`}
            >
              {group.providerLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {activeGroup && (
        <div className="mt-3 space-y-1">
          {activeGroup.models.map((model) => {
            const visible = !hiddenSet.has(model.value);
            return (
              <div
                key={model.value}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {model.label}
                </span>
                <Switch
                  className="shrink-0"
                  checked={visible}
                  onCheckedChange={(checked) => saveVisibility(model.value, checked)}
                  data-testid={`settings-prompt-model-${model.value.replace(/:/g, '-')}`}
                  aria-label={t('settings.promptModelVisibilityToggle', {
                    model: model.label,
                  })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
