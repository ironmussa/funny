import type { EffortLevel } from '@funny/shared';
import {
  DEFAULT_THREAD_RECAP_MIN_ABSENCE_MINUTES,
  resolveUtilityModel,
  UTILITY_MODEL_AGENT_PROVIDERS,
  UTILITY_MODEL_LLM_PROVIDERS,
  UtilityModelSetting,
} from '@funny/shared/contracts/profile';
import { getDefaultModel } from '@funny/shared/models';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelCombobox } from '@/components/general-settings-project/ModelCombobox';
import { SegmentedControl } from '@/components/general-settings-project/setting-primitives';
import { useProviderModelOptions } from '@/components/general-settings-project/use-provider-model-options';
import { SettingRow, SettingsSection } from '@/components/settings/SettingRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { updateProfile } from '@/data/profile/actions';
import { useProfile } from '@/data/profile/hooks';
import { getEffortLevels, normalizeEffort, PROVIDERS } from '@/lib/providers';

type UtilityProvider = UtilityModelSetting['provider'];
type UtilityAgentProvider = (typeof UTILITY_MODEL_AGENT_PROVIDERS)[number];

/** The absences (minutes) offered before a recap shows; the saved value is kept if it is another. */
const RECAP_ABSENCE_CHOICES: readonly number[] = [1, 5, 15, 30, 60, 120, 240];

const AGENT_PROVIDER_SET: ReadonlySet<string> = new Set(UTILITY_MODEL_AGENT_PROVIDERS);
const DIRECT_LLM_PROVIDERS = UTILITY_MODEL_LLM_PROVIDERS.filter((p) => p !== 'claude-sdk');

function isAgentProvider(provider: UtilityProvider): provider is UtilityAgentProvider {
  return AGENT_PROVIDER_SET.has(provider);
}

/** Legacy `claude-sdk` profiles display and save as `claude`. */
function normalizeProvider(provider: UtilityProvider): UtilityProvider {
  return provider === 'claude-sdk' ? 'claude' : provider;
}

/** Providers that accept a custom base URL (`openai-compatible` requires it, `ollama` is optional). */
function supportsBaseUrl(provider: UtilityProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}

async function saveProfile(
  data: Parameters<typeof updateProfile>[0],
  t: (key: string) => string,
): Promise<void> {
  const result = await updateProfile(data);
  if (result.isOk()) toast.success(t('settings.saved'), { id: 'settings-saved' });
  else toast.error(t('profile.saveFailed'));
}

/**
 * Preferences › Models: the utility model used for helper text (thread
 * recaps, commit messages) and the "Show thread recaps" switch (openspec
 * `thread-recap`). Both are saved in the user's profile on the server, so
 * they follow the user across devices.
 */
export function UtilityModelSettings() {
  const { t } = useTranslation();
  const profile = useProfile();
  if (!profile) return null;
  const setting = profile.utilityModel ?? null;
  return (
    <>
      <SettingsSection settingId="models.utility-model" className="mt-6">
        {t('settings.utilityModel')}
      </SettingsSection>
      <p className="text-muted-foreground px-1 pb-3 text-sm">{t('settings.utilityModelDesc')}</p>
      <div className="settings-card">
        <SettingRow
          settingId="models.thread-recap"
          title={t('settings.threadRecap')}
          description={t('settings.threadRecapDesc')}
        >
          <Switch
            checked={profile.threadRecapEnabled}
            onCheckedChange={(checked) => void saveProfile({ threadRecapEnabled: checked }, t)}
            data-testid="settings-thread-recap-toggle"
          />
        </SettingRow>
        <RecapAbsenceSetting
          minutes={profile.threadRecapMinAbsenceMinutes ?? DEFAULT_THREAD_RECAP_MIN_ABSENCE_MINUTES}
          disabled={!profile.threadRecapEnabled}
        />
        <UtilityModelForm key={JSON.stringify(setting)} setting={setting} />
      </div>
    </>
  );
}

function RecapAbsenceSetting({ minutes, disabled }: { minutes: number; disabled: boolean }) {
  const { t } = useTranslation();
  const choices = RECAP_ABSENCE_CHOICES.includes(minutes)
    ? [...RECAP_ABSENCE_CHOICES]
    : [...RECAP_ABSENCE_CHOICES, minutes].sort((a, b) => a - b);
  return (
    <SettingRow
      settingId="models.thread-recap-absence"
      title={t('settings.threadRecapAbsence')}
      description={t('settings.threadRecapAbsenceDesc')}
    >
      <Select
        value={String(minutes)}
        disabled={disabled}
        onValueChange={(v) => void saveProfile({ threadRecapMinAbsenceMinutes: Number(v) }, t)}
      >
        <SelectTrigger className="w-[180px]" data-testid="settings-thread-recap-absence">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((m) => (
            <SelectItem
              key={m}
              value={String(m)}
              data-testid={`settings-thread-recap-absence-${m}`}
            >
              {t('settings.threadRecapAbsenceMinutes', { count: m })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function UtilityModelForm({ setting }: { setting: UtilityModelSetting | null }) {
  const { t } = useTranslation();
  const initial = resolveUtilityModel(setting);
  const initialProvider = normalizeProvider(initial.provider);
  const [provider, setProvider] = useState<UtilityProvider>(initialProvider);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<string>(initial.effort ?? '');
  const [baseURL, setBaseURL] = useState(initial.baseURL ?? '');
  const [saving, setSaving] = useState(false);

  const agentProvider = isAgentProvider(provider) ? provider : null;
  const rawModelOptions = useProviderModelOptions(agentProvider ?? 'claude');
  const modelOptions =
    agentProvider && model && !rawModelOptions.some((o) => o.value === model)
      ? [{ value: model, label: model }, ...rawModelOptions]
      : rawModelOptions;

  const effortOptions = agentProvider ? getEffortLevels(model, agentProvider) : [];
  const currentEffort = agentProvider ? normalizeEffort(model, agentProvider, effort) : '';

  const providerOptions = [
    ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
    ...DIRECT_LLM_PROVIDERS.map((id) => ({
      value: id,
      label: t(`settings.utilityModelProviders.${id}`),
    })),
  ];

  const draft: UtilityModelSetting = {
    provider,
    model: model.trim(),
  };
  if (effortOptions.length > 0 && currentEffort) {
    // SAFETY: currentEffort comes from normalizeEffort / getEffortLevels, which only yields EffortLevel values.
    draft.effort = currentEffort as EffortLevel;
  }
  if (supportsBaseUrl(provider)) {
    const trimmedBaseUrl = baseURL.trim();
    if (trimmedBaseUrl) draft.baseURL = trimmedBaseUrl;
  }
  const parsed = UtilityModelSetting.safeParse(draft);

  const handleProviderChange = (nextRaw: string) => {
    // SAFETY: options are built from PROVIDERS and DIRECT_LLM_PROVIDERS, all of which are UtilityProvider.
    const next = nextRaw as UtilityProvider;
    setProvider(next);
    if (isAgentProvider(next)) {
      const nextModel = getDefaultModel(next);
      setModel(nextModel);
      setEffort(normalizeEffort(nextModel, next, effort));
    } else {
      if (isAgentProvider(provider)) setModel('');
      setEffort('');
    }
  };

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    if (agentProvider) {
      setEffort(normalizeEffort(nextModel, agentProvider, effort));
    }
  };

  const save = async (value: UtilityModelSetting | null) => {
    setSaving(true);
    await saveProfile({ utilityModel: value }, t);
    setSaving(false);
  };

  return (
    <>
      <SettingRow
        settingId="models.utility-model-provider"
        title={t('settings.utilityModelProvider')}
        description={t('settings.utilityModelProviderDesc')}
      >
        <div className="flex items-center gap-2">
          <ModelCombobox
            value={provider}
            onChange={handleProviderChange}
            options={providerOptions}
            placeholder={t('settings.selectProvider')}
            searchPlaceholder={t('settings.searchProvider')}
            testId="settings-utility-model-provider"
          />
          {agentProvider && (
            <ModelCombobox
              value={model}
              onChange={handleModelChange}
              options={modelOptions}
              placeholder={t('settings.selectModel')}
              searchPlaceholder={t('settings.searchModel')}
              testId="settings-utility-model-select"
            />
          )}
        </div>
      </SettingRow>
      {!agentProvider && (
        <SettingRow
          settingId="models.utility-model-name"
          title={t('settings.utilityModelName')}
          description={t('settings.utilityModelNameDesc')}
        >
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-[180px]"
            data-testid="settings-utility-model-name"
          />
        </SettingRow>
      )}
      {effortOptions.length > 0 && (
        <SettingRow
          settingId="models.utility-model-effort"
          title={t('settings.utilityModelEffort')}
          description={t('settings.utilityModelEffortDesc')}
        >
          <SegmentedControl<string>
            value={currentEffort}
            onChange={setEffort}
            options={effortOptions.map((level) => ({
              value: level.value,
              label: t(`settings.effort.${level.value}`, level.label),
              testId: `settings-utility-model-effort-${level.value}`,
            }))}
          />
        </SettingRow>
      )}
      {supportsBaseUrl(provider) && (
        <SettingRow
          settingId="models.utility-model-base-url"
          title={t('settings.utilityModelBaseUrl')}
          description={t('settings.utilityModelBaseUrlDesc')}
        >
          <Input
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://"
            className="w-[240px]"
            data-testid="settings-utility-model-base-url"
          />
        </SettingRow>
      )}
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        {!parsed.success && (
          <p className="text-muted-foreground mr-auto text-xs">
            {t('settings.utilityModelInvalid')}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || setting === null}
          onClick={() => void save(null)}
          data-testid="settings-utility-model-reset"
        >
          {t('settings.utilityModelReset')}
        </Button>
        <Button
          size="sm"
          disabled={saving || !parsed.success}
          onClick={() => parsed.success && void save(parsed.data)}
          data-testid="settings-utility-model-save"
        >
          {t('settings.utilityModelSave')}
        </Button>
      </div>
    </>
  );
}
