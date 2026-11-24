import {
  resolveUtilityModel,
  UTILITY_MODEL_PROVIDERS,
  UtilityModelSetting,
} from '@funny/shared/contracts/profile';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { updateProfile } from '@/data/profile/actions';
import { useProfile } from '@/data/profile/hooks';

type Provider = (typeof UTILITY_MODEL_PROVIDERS)[number];

/** The provider that cannot run without a base URL (`UtilityModelSetting`). */
function needsBaseUrl(provider: Provider): boolean {
  return provider === 'openai-compatible';
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
        <UtilityModelForm key={JSON.stringify(setting)} setting={setting} />
      </div>
    </>
  );
}

function UtilityModelForm({ setting }: { setting: UtilityModelSetting | null }) {
  const { t } = useTranslation();
  const initial = resolveUtilityModel(setting);
  const [provider, setProvider] = useState<Provider>(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [baseURL, setBaseURL] = useState(initial.baseURL ?? '');
  const [saving, setSaving] = useState(false);

  const parsed = UtilityModelSetting.safeParse({
    provider,
    model: model.trim(),
    baseURL: needsBaseUrl(provider) ? baseURL.trim() || undefined : undefined,
  });

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
        <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
          <SelectTrigger className="w-[180px]" data-testid="settings-utility-model-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UTILITY_MODEL_PROVIDERS.map((id) => (
              <SelectItem key={id} value={id} data-testid={`settings-utility-model-provider-${id}`}>
                {t(`settings.utilityModelProviders.${id}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
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
      {needsBaseUrl(provider) && (
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
