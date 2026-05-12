import type { UserProfile } from '@funny/shared';
import { PROVIDER_KEY_REGISTRY } from '@funny/shared/models';
import { Check, Mail, Send } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { AgentTemplateSettings } from '@/components/settings/AgentTemplateSettings';
import { OrganizationManagement } from '@/components/settings/OrganizationManagement';
import { RunnersSettings } from '@/components/settings/RunnersSettings';
import { SettingRow } from '@/components/settings/SettingRow';
import { SystemSettings } from '@/components/settings/SystemSettings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  playNotificationSound,
  showAgentNotification,
  useNotifications,
} from '@/hooks/use-notifications';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  editorLabels,
  type Editor,
  type FontSize,
  type TerminalShell,
  useSettingsStore,
} from '@/stores/settings-store';

type GeneralPage =
  | 'general'
  | 'appearance'
  | 'github'
  | 'ai-keys'
  | 'speech'
  | 'email'
  | 'organizations'
  | 'runners'
  | 'system'
  | 'agent-templates';

interface ThemeOption {
  value: string;
  label: string;
  colors: { bg: string; sidebar: string; accent: string; fg: string };
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'one-dark',
    label: 'settings.themes.oneDark',
    colors: { bg: '#252931', sidebar: '#1e2127', accent: '#528bff', fg: '#b8beca' },
  },
  {
    value: 'dracula',
    label: 'settings.themes.dracula',
    colors: { bg: '#282A36', sidebar: '#21222C', accent: '#BD93F9', fg: '#F8F8F2' },
  },
  {
    value: 'github-dark',
    label: 'settings.themes.githubDark',
    colors: { bg: '#0d1117', sidebar: '#010409', accent: '#2f81f7', fg: '#e6edf3' },
  },
  {
    value: 'night-owl',
    label: 'settings.themes.nightOwl',
    colors: { bg: '#011627', sidebar: '#01111d', accent: '#7e57c2', fg: '#d6deeb' },
  },
  {
    value: 'catppuccin',
    label: 'settings.themes.catppuccin',
    colors: { bg: '#1e1e2e', sidebar: '#181825', accent: '#89b4fa', fg: '#cdd6f4' },
  },
  {
    value: 'sunrise',
    label: 'settings.themes.sunrise',
    colors: { bg: '#FAFAFA', sidebar: '#F5F5F5', accent: '#171717', fg: '#171717' },
  },
  {
    value: 'monochrome',
    label: 'settings.themes.monochrome',
    colors: { bg: '#ffffff', sidebar: '#f7f7f7', accent: '#000000', fg: '#000000' },
  },
  {
    value: 'monochrome-dark',
    label: 'settings.themes.monochromeDark',
    colors: { bg: '#121212', sidebar: '#0d0d0d', accent: '#ededed', fg: '#ededed' },
  },
];

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function getDisplayNames(code: string): Intl.DisplayNames {
  let dn = displayNamesCache.get(code);
  if (!dn) {
    dn = new Intl.DisplayNames([code], { type: 'language' });
    displayNamesCache.set(code, dn);
  }
  return dn;
}

function getLanguageName(code: string): string {
  try {
    const name = getDisplayNames(code).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

function ThemeCard({
  option,
  selected,
  onClick,
  t,
}: {
  option: ThemeOption;
  selected: boolean;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const { bg, sidebar, accent, fg } = option.colors;
  return (
    <button
      onClick={onClick}
      data-testid={`preferences-theme-${option.value}`}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-lg border-2 transition-colors',
        selected ? 'border-primary' : 'border-border/50 hover:border-border',
      )}
    >
      <div className="flex h-16" style={{ backgroundColor: bg }}>
        <div
          className="w-5 border-r"
          style={{ backgroundColor: sidebar, borderColor: `${fg}15` }}
        />
        <div className="flex flex-1 flex-col gap-1 p-2">
          <div className="h-1.5 w-10 rounded-full" style={{ backgroundColor: fg, opacity: 0.7 }} />
          <div className="h-1.5 w-14 rounded-full" style={{ backgroundColor: fg, opacity: 0.3 }} />
          <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: accent }} />
        </div>
      </div>
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <span className="text-xs font-medium">{t(option.label)}</span>
        {selected && <Check className="icon-xs text-primary" />}
      </div>
    </button>
  );
}

interface Props {
  activePreferencesPage: GeneralPage;
}

/**
 * The right-side scrollable content area of the preferences view. Owns every
 * page's local state (provider keys, SMTP settings) and the auto-save
 * handlers. Extracted so GeneralSettingsView is a thin layout shell.
 */
export function PreferencesContent({ activePreferencesPage }: Props) {
  const {
    defaultEditor,
    useInternalEditor,
    terminalShell,
    availableShells,
    fontSize,
    notificationsEnabled,
    notificationSoundEnabled,
    setDefaultEditor,
    setUseInternalEditor,
    setTerminalShell,
    setFontSize,
    setNotificationsEnabled,
    setNotificationSoundEnabled,
    fetchAvailableShells,
  } = useSettingsStore(
    useShallow((s) => ({
      defaultEditor: s.defaultEditor,
      useInternalEditor: s.useInternalEditor,
      terminalShell: s.terminalShell,
      availableShells: s.availableShells,
      fontSize: s.fontSize,
      notificationsEnabled: s.notificationsEnabled,
      notificationSoundEnabled: s.notificationSoundEnabled,
      setDefaultEditor: s.setDefaultEditor,
      setUseInternalEditor: s.setUseInternalEditor,
      setTerminalShell: s.setTerminalShell,
      setFontSize: s.setFontSize,
      setNotificationsEnabled: s.setNotificationsEnabled,
      setNotificationSoundEnabled: s.setNotificationSoundEnabled,
      fetchAvailableShells: s.fetchAvailableShells,
    })),
  );
  const {
    permission: notificationPermission,
    requestPermission,
    supported: notificationsSupported,
  } = useNotifications();
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [keySaving, setKeySaving] = useState<Record<string, boolean>>({});

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [smtpSource, setSmtpSource] = useState<'database' | 'environment' | 'none'>('none');
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);

  useEffect(() => {
    api.getProfile().then((result) => {
      if (result.isOk() && result.value) {
        const profile = result.value as UserProfile;
        setKeyPresence(profile.providerKeys ?? {});
      }
    });
    setKeyInputs({});
    api.getSmtpSettings().then((result) => {
      if (result.isOk()) {
        setSmtpHost(result.value.host);
        setSmtpPort(result.value.port);
        setSmtpUser(result.value.user);
        setSmtpFrom(result.value.from);
        setSmtpHasPassword(result.value.hasPassword);
        setSmtpSource(result.value.source);
      }
    });
    fetchAvailableShells();
  }, [fetchAvailableShells]);

  const handleEditorChange = useCallback(
    (v: string) => {
      setDefaultEditor(v as Editor);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setDefaultEditor, t],
  );

  const handleInternalEditorChange = useCallback(
    (checked: boolean) => {
      setUseInternalEditor(checked);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setUseInternalEditor, t],
  );

  const handleShellChange = useCallback(
    (v: string) => {
      setTerminalShell(v as TerminalShell);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setTerminalShell, t],
  );

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value);
      api.updateProfile({ theme: value });
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setTheme, t],
  );

  const handleFontSizeChange = useCallback(
    (v: string) => {
      setFontSize(v as FontSize);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setFontSize, t],
  );

  const handleNotificationsToggle = useCallback(
    async (checked: boolean) => {
      if (checked) {
        const result = notificationPermission === 'granted' ? 'granted' : await requestPermission();
        if (result !== 'granted') {
          toast.error(t('settings.notificationsDenied'));
          setNotificationsEnabled(false);
          return;
        }
      }
      setNotificationsEnabled(checked);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [notificationPermission, requestPermission, setNotificationsEnabled, t],
  );

  const handleTestNotification = useCallback(async () => {
    if (!notificationsSupported) {
      toast.error(t('settings.notificationsUnsupported'));
      return;
    }
    let perm = notificationPermission;
    if (perm !== 'granted') {
      perm = await requestPermission();
    }
    if (perm !== 'granted') {
      toast.error(t('settings.notificationsDenied'));
      return;
    }
    const result = showAgentNotification(
      t('settings.notificationsTestTitle'),
      t('settings.notificationsTestBody'),
      { force: true },
    );
    if (result.ok) {
      toast.success(t('settings.notificationsTestSent'));
    } else {
      toast.error(t('settings.notificationsTestFailed', { reason: result.reason }));
    }
  }, [notificationPermission, notificationsSupported, requestPermission, t]);

  const handleNotificationSoundToggle = useCallback(
    (checked: boolean) => {
      setNotificationSoundEnabled(checked);
      if (checked) playNotificationSound();
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setNotificationSoundEnabled, t],
  );

  const handleTestNotificationSound = useCallback(() => {
    playNotificationSound();
  }, []);

  const handleLanguageChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [i18n, t],
  );

  const handleSaveProviderKey = useCallback(
    async (id: string) => {
      const value = keyInputs[id];
      if (!value) return;
      setKeySaving((prev) => ({ ...prev, [id]: true }));
      const result = await api.updateProfile({ providerKey: { id, value } });
      if (result.isOk()) {
        setKeyPresence(result.value.providerKeys ?? {});
        setKeyInputs((prev) => ({ ...prev, [id]: '' }));
        toast.success(t('profile.tokenSaved'));
      } else {
        toast.error(t('profile.saveFailed'));
      }
      setKeySaving((prev) => ({ ...prev, [id]: false }));
    },
    [keyInputs, t],
  );

  const handleClearProviderKey = useCallback(
    async (id: string) => {
      setKeySaving((prev) => ({ ...prev, [id]: true }));
      const result = await api.updateProfile({ providerKey: { id, value: null } });
      if (result.isOk()) {
        setKeyPresence(result.value.providerKeys ?? {});
        setKeyInputs((prev) => ({ ...prev, [id]: '' }));
        toast.success(t('profile.tokenCleared'));
      }
      setKeySaving((prev) => ({ ...prev, [id]: false }));
    },
    [t],
  );

  const handleSaveSmtp = useCallback(async () => {
    setSmtpSaving(true);
    const result = await api.updateSmtpSettings({
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      pass: smtpPass || undefined,
      from: smtpFrom,
    });
    if (result.isOk()) {
      toast.success('SMTP settings saved');
      if (smtpPass) setSmtpHasPassword(true);
      setSmtpSource('database');
      setSmtpPass('');
    } else {
      toast.error('Failed to save SMTP settings');
    }
    setSmtpSaving(false);
  }, [smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom]);

  const handleTestSmtp = useCallback(async () => {
    setSmtpTesting(true);
    const result = await api.testSmtpSettings();
    if (result.isOk()) {
      toast.success(`Test email sent to ${result.value.sentTo}`);
    } else {
      toast.error('Failed to send test email. Check your SMTP settings.');
    }
    setSmtpTesting(false);
  }, []);

  return (
    <ScrollArea className="min-h-0 max-w-2xl flex-1">
      <div className="p-6">
        {activePreferencesPage === 'general' && (
          <>
            <h3 className="settings-section-header">{t('settings.general')}</h3>
            <div className="settings-card">
              <SettingRow
                title={t('settings.defaultEditor')}
                description={t('settings.defaultEditorDesc')}
              >
                <Select value={defaultEditor} onValueChange={handleEditorChange}>
                  <SelectTrigger className="w-[140px]" data-testid="preferences-editor-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(editorLabels) as [Editor, string][]).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title={t('settings.useInternalEditor')}
                description={t('settings.useInternalEditorDesc')}
              >
                <Checkbox
                  checked={useInternalEditor}
                  onCheckedChange={(checked) => handleInternalEditorChange(!!checked)}
                  data-testid="preferences-internal-editor"
                />
              </SettingRow>
              <SettingRow title={t('settings.language')} description={t('settings.languageDesc')}>
                <Select value={i18n.language} onValueChange={handleLanguageChange}>
                  <SelectTrigger className="w-[140px]" data-testid="preferences-language-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(i18n.options.resources ?? {}).map((code) => (
                      <SelectItem key={code} value={code}>
                        {getLanguageName(code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title={t('settings.terminalShell')}
                description={t('settings.terminalShellDesc')}
              >
                <Select value={terminalShell} onValueChange={handleShellChange}>
                  <SelectTrigger className="w-[160px]" data-testid="preferences-shell-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('settings.shellDefault')}</SelectItem>
                    {availableShells.map((shell) => (
                      <SelectItem key={shell.id} value={shell.id}>
                        {shell.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title={t('settings.notifications')}
                description={
                  notificationsSupported
                    ? notificationPermission === 'denied'
                      ? t('settings.notificationsBlocked')
                      : t('settings.notificationsDesc')
                    : t('settings.notificationsUnsupported')
                }
              >
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTestNotification}
                    disabled={!notificationsSupported || notificationPermission === 'denied'}
                    data-testid="preferences-notifications-test"
                  >
                    {t('settings.notificationsTest')}
                  </Button>
                  <Checkbox
                    checked={notificationsEnabled && notificationPermission === 'granted'}
                    disabled={!notificationsSupported || notificationPermission === 'denied'}
                    onCheckedChange={(checked) => handleNotificationsToggle(!!checked)}
                    data-testid="preferences-notifications-toggle"
                  />
                </div>
              </SettingRow>
              <SettingRow
                title={t('settings.notificationsSound')}
                description={t('settings.notificationsSoundDesc')}
              >
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTestNotificationSound}
                    data-testid="preferences-notifications-sound-test"
                  >
                    {t('settings.notificationsTest')}
                  </Button>
                  <Checkbox
                    checked={notificationSoundEnabled}
                    onCheckedChange={(checked) => handleNotificationSoundToggle(!!checked)}
                    data-testid="preferences-notifications-sound-toggle"
                  />
                </div>
              </SettingRow>
            </div>
          </>
        )}

        {activePreferencesPage === 'appearance' && (
          <>
            <h3 className="settings-section-header">{t('settings.appearance')}</h3>
            <p className="px-1 pb-3 text-xs text-muted-foreground">{t('settings.themeDesc')}</p>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map((opt) => (
                <ThemeCard
                  key={opt.value}
                  option={opt}
                  selected={(theme ?? 'one-dark') === opt.value}
                  onClick={() => handleThemeChange(opt.value)}
                  t={t}
                />
              ))}
            </div>
            <h3 className="settings-section-header mt-6">{t('settings.fontSize')}</h3>
            <div className="settings-card">
              <SettingRow title={t('settings.fontSize')} description={t('settings.fontSizeDesc')}>
                <Select value={fontSize} onValueChange={handleFontSizeChange}>
                  <SelectTrigger className="w-[140px]" data-testid="preferences-font-size-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">{t('settings.fontSizeSmall')}</SelectItem>
                    <SelectItem value="default">{t('settings.fontSizeDefault')}</SelectItem>
                    <SelectItem value="large">{t('settings.fontSizeLarge')}</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>
          </>
        )}

        {activePreferencesPage === 'github' && (
          <ProviderKeyPanel
            id="github"
            title={t('profile.githubTokenLabel')}
            description={t('profile.githubTokenDesc')}
            keyInputs={keyInputs}
            keyPresence={keyPresence}
            keySaving={keySaving}
            setKeyInputs={setKeyInputs}
            handleSave={handleSaveProviderKey}
            handleClear={handleClearProviderKey}
            saveTestId="preferences-save-token"
            inputTestId="preferences-github-token"
            clearTestId="preferences-clear-token"
            t={t}
          />
        )}

        {activePreferencesPage === 'ai-keys' && (
          <>
            <h3 className="settings-section-header">AI Providers</h3>
            <p className="px-1 pb-3 text-xs text-muted-foreground">
              Configure API keys for AI providers. Keys are encrypted at rest.
            </p>
            <div className="settings-card space-y-0 divide-y divide-border">
              {PROVIDER_KEY_REGISTRY.filter((k) => k.id !== 'github' && k.id !== 'assemblyai').map(
                (keyConfig) => (
                  <div key={keyConfig.id} className="px-4 py-3.5">
                    <p className="settings-row-title">{keyConfig.label}</p>
                    <p className="settings-row-desc mb-2">
                      Get your key at{' '}
                      <a
                        href={keyConfig.helpUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {new URL(keyConfig.helpUrl).hostname}
                      </a>
                      . {keyConfig.description}
                    </p>
                    <ProviderKeyRow
                      id={keyConfig.id}
                      label={keyConfig.label}
                      keyInputs={keyInputs}
                      keyPresence={keyPresence}
                      keySaving={keySaving}
                      setKeyInputs={setKeyInputs}
                      handleSave={handleSaveProviderKey}
                      handleClear={handleClearProviderKey}
                      t={t}
                    />
                  </div>
                ),
              )}
            </div>
          </>
        )}

        {activePreferencesPage === 'speech' && (
          <>
            <h3 className="settings-section-header">Speech</h3>
            <p className="px-1 pb-3 text-xs text-muted-foreground">
              Configure an AssemblyAI API key to enable voice dictation in the prompt input.
            </p>
            <div className="settings-card">
              <div className="px-4 py-3.5">
                <p className="settings-row-title">AssemblyAI API Key</p>
                <p className="settings-row-desc mb-2">
                  Get your key at{' '}
                  <a
                    href="https://www.assemblyai.com/dashboard/signup"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    assemblyai.com
                  </a>
                  . The key is encrypted at rest.
                </p>
                <ProviderKeyRow
                  id="assemblyai"
                  label="AssemblyAI API Key"
                  keyInputs={keyInputs}
                  keyPresence={keyPresence}
                  keySaving={keySaving}
                  setKeyInputs={setKeyInputs}
                  handleSave={handleSaveProviderKey}
                  handleClear={handleClearProviderKey}
                  t={t}
                />
              </div>
            </div>
          </>
        )}

        {activePreferencesPage === 'organizations' && <OrganizationManagement />}
        {activePreferencesPage === 'runners' && <RunnersSettings />}
        {activePreferencesPage === 'agent-templates' && <AgentTemplateSettings />}
        {activePreferencesPage === 'system' && <SystemSettings />}

        {activePreferencesPage === 'email' && (
          <SmtpPanel
            smtpHost={smtpHost}
            smtpPort={smtpPort}
            smtpUser={smtpUser}
            smtpPass={smtpPass}
            smtpFrom={smtpFrom}
            smtpHasPassword={smtpHasPassword}
            smtpSource={smtpSource}
            smtpSaving={smtpSaving}
            smtpTesting={smtpTesting}
            setSmtpHost={setSmtpHost}
            setSmtpPort={setSmtpPort}
            setSmtpUser={setSmtpUser}
            setSmtpPass={setSmtpPass}
            setSmtpFrom={setSmtpFrom}
            handleSaveSmtp={handleSaveSmtp}
            handleTestSmtp={handleTestSmtp}
          />
        )}
      </div>
    </ScrollArea>
  );
}

interface KeyRowProps {
  id: string;
  label: string;
  keyInputs: Record<string, string>;
  keyPresence: Record<string, boolean>;
  keySaving: Record<string, boolean>;
  setKeyInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  handleSave: (id: string) => void;
  handleClear: (id: string) => void;
  t: (key: string) => string;
}

function ProviderKeyRow({
  id,
  label,
  keyInputs,
  keyPresence,
  keySaving,
  setKeyInputs,
  handleSave,
  handleClear,
  t,
}: KeyRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        value={keyInputs[id] ?? ''}
        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
        data-testid={`preferences-${id}-key`}
        placeholder={keyPresence[id] ? t('profile.tokenSaved') : `Enter your ${label}`}
        className="text-sm"
      />
      <Button
        size="sm"
        onClick={() => handleSave(id)}
        disabled={!keyInputs[id] || !!keySaving[id]}
        data-testid={`preferences-save-${id}-key`}
      >
        {keySaving[id] ? t('common.saving') : t('common.save')}
      </Button>
      {keyPresence[id] && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-xs text-destructive hover:text-destructive"
          onClick={() => handleClear(id)}
          disabled={!!keySaving[id]}
          data-testid={`preferences-clear-${id}-key`}
        >
          {t('profile.clearToken')}
        </Button>
      )}
    </div>
  );
}

function ProviderKeyPanel({
  id,
  title,
  description,
  keyInputs,
  keyPresence,
  keySaving,
  setKeyInputs,
  handleSave,
  handleClear,
  saveTestId,
  inputTestId,
  clearTestId,
  t,
}: KeyRowProps & {
  title: string;
  description: string;
  saveTestId: string;
  inputTestId: string;
  clearTestId: string;
}) {
  return (
    <>
      <h3 className="settings-section-header">GitHub</h3>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="settings-row-title">{title}</p>
          <p className="settings-row-desc mb-2">{description}</p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={keyInputs[id] ?? ''}
              onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
              data-testid={inputTestId}
              placeholder={
                keyPresence[id] ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
              }
              className="text-sm"
            />
            <Button
              size="sm"
              onClick={() => handleSave(id)}
              disabled={!keyInputs[id] || !!keySaving[id]}
              data-testid={saveTestId}
            >
              {keySaving[id] ? t('common.saving') : t('common.save')}
            </Button>
            {keyPresence[id] && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-xs text-destructive hover:text-destructive"
                onClick={() => handleClear(id)}
                disabled={!!keySaving[id]}
                data-testid={clearTestId}
              >
                {t('profile.clearToken')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface SmtpPanelProps {
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpHasPassword: boolean;
  smtpSource: 'database' | 'environment' | 'none';
  smtpSaving: boolean;
  smtpTesting: boolean;
  setSmtpHost: (v: string) => void;
  setSmtpPort: (v: string) => void;
  setSmtpUser: (v: string) => void;
  setSmtpPass: (v: string) => void;
  setSmtpFrom: (v: string) => void;
  handleSaveSmtp: () => void;
  handleTestSmtp: () => void;
}

function SmtpPanel({
  smtpHost,
  smtpPort,
  smtpUser,
  smtpPass,
  smtpFrom,
  smtpHasPassword,
  smtpSource,
  smtpSaving,
  smtpTesting,
  setSmtpHost,
  setSmtpPort,
  setSmtpUser,
  setSmtpPass,
  setSmtpFrom,
  handleSaveSmtp,
  handleTestSmtp,
}: SmtpPanelProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <h3 className="settings-section-header">Email (SMTP)</h3>
        {smtpSource !== 'none' && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              smtpSource === 'database'
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground',
            )}
            data-testid="preferences-smtp-status"
          >
            {smtpSource === 'database' ? 'Configured' : 'Env vars'}
          </span>
        )}
      </div>
      <p className="px-1 pb-3 text-xs text-muted-foreground">
        Used for sending team invitation emails. Set via env vars (SMTP_HOST, SMTP_USER, SMTP_PASS)
        or configure below.
      </p>
      <div className="settings-card">
        <div className="space-y-3 px-4 py-3.5">
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Host</label>
              <Input
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.gmail.com"
                className="text-sm"
                data-testid="preferences-smtp-host"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Port</label>
              <Input
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                placeholder="587"
                className="text-sm"
                data-testid="preferences-smtp-port"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Username</label>
            <Input
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="you@example.com"
              className="text-sm"
              data-testid="preferences-smtp-user"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Password</label>
            <Input
              type="password"
              value={smtpPass}
              onChange={(e) => setSmtpPass(e.target.value)}
              placeholder={
                smtpHasPassword
                  ? 'Password saved (enter new to replace)'
                  : 'App password or SMTP password'
              }
              className="text-sm"
              data-testid="preferences-smtp-pass"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">From address</label>
            <Input
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="noreply@example.com"
              className="text-sm"
              data-testid="preferences-smtp-from"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleSaveSmtp}
              disabled={!smtpHost || !smtpUser || smtpSaving}
              data-testid="preferences-smtp-save"
            >
              <Mail className="icon-sm mr-1.5" />
              {smtpSaving ? 'Saving...' : 'Save SMTP'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleTestSmtp}
              disabled={smtpSource === 'none' || smtpTesting}
              data-testid="preferences-smtp-test"
            >
              <Send className="icon-sm mr-1.5" />
              {smtpTesting ? 'Sending...' : 'Send Test Email'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
