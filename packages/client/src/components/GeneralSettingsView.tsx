import type { UserProfile } from '@funny/shared';
import { PROVIDER_KEY_REGISTRY } from '@funny/shared/models';
import {
  ArrowLeft,
  Bot,
  Building2,
  Check,
  Cpu,
  Github,
  Mail,
  Mic,
  Palette,
  Send,
  Server,
  SlidersHorizontal,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

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
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import {
  useSettingsStore,
  editorLabels,
  type Editor,
  type FontSize,
  type TerminalShell,
} from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import { AgentTemplateSettings } from './settings/AgentTemplateSettings';
import { OrganizationManagement } from './settings/OrganizationManagement';
import { RunnersSettings } from './settings/RunnersSettings';
import { SettingRow } from './settings/SettingRow';
import { SystemSettings } from './settings/SystemSettings';

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

const NAV_ITEMS: Array<{ id: GeneralPage; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'general', label: 'settings.general', icon: SlidersHorizontal },
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'ai-keys', label: 'AI Providers', icon: Bot },
  { id: 'speech', label: 'Speech', icon: Mic },
  { id: 'email', label: 'Email (SMTP)', icon: Mail },
  { id: 'organizations', label: 'Organizations', icon: Building2 },
  { id: 'runners', label: 'Runners', icon: Server },
  { id: 'agent-templates', label: 'Agent Templates', icon: Bot },
  { id: 'system', label: 'System', icon: Cpu },
];

function getLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

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

export function GeneralSettingsView() {
  const navigate = useNavigate();
  const {
    defaultEditor,
    useInternalEditor,
    terminalShell,
    availableShells,
    fontSize,
    setDefaultEditor,
    setUseInternalEditor,
    setTerminalShell,
    setFontSize,
    fetchAvailableShells,
  } = useSettingsStore(
    useShallow((s) => ({
      defaultEditor: s.defaultEditor,
      useInternalEditor: s.useInternalEditor,
      terminalShell: s.terminalShell,
      availableShells: s.availableShells,
      fontSize: s.fontSize,
      setDefaultEditor: s.setDefaultEditor,
      setUseInternalEditor: s.setUseInternalEditor,
      setTerminalShell: s.setTerminalShell,
      setFontSize: s.setFontSize,
      fetchAvailableShells: s.fetchAvailableShells,
    })),
  );
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;

  // Provider keys state (generic: keyed by provider ID)
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [keySaving, setKeySaving] = useState<Record<string, boolean>>({});

  // SMTP state
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [smtpSource, setSmtpSource] = useState<'database' | 'environment' | 'none'>('none');
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);

  // Load data on mount
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

  // Auto-save handlers
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

  const handleLanguageChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [i18n, t],
  );

  // Generic provider key handlers
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

  // SMTP handlers
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
    <div className="flex h-full w-full">
      {/* Left sidebar nav */}
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="px-4 py-3">
          <div className="flex items-center gap-2">
            <TooltipIconButton
              onClick={() => {
                useUIStore.getState().setGeneralSettingsOpen(false);
                navigate(buildPath('/'));
              }}
              className="text-muted-foreground hover:text-foreground"
              data-testid="preferences-back"
              tooltip={t('common.back')}
            >
              <ArrowLeft className="icon-sm" />
            </TooltipIconButton>
            <h1 className="text-sm font-medium">{t('settings.title')}</h1>
          </div>
        </SidebarHeader>

        <SidebarContent className="px-2 pb-2">
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activePreferencesPage === item.id}
                    onClick={() => navigate(buildPath(`/preferences/${item.id}`))}
                    data-testid={`preferences-nav-${item.id}`}
                  >
                    <Icon className="icon-base" />
                    <span>{item.label.startsWith('settings.') ? t(item.label) : item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>

      {/* Right content area */}
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
                      {(Object.entries(editorLabels) as [Editor, string][]).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
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
            <>
              <h3 className="settings-section-header">GitHub</h3>
              <div className="settings-card">
                <div className="px-4 py-3.5">
                  <p className="settings-row-title">{t('profile.githubTokenLabel')}</p>
                  <p className="settings-row-desc mb-2">{t('profile.githubTokenDesc')}</p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      value={keyInputs.github ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, github: e.target.value }))
                      }
                      data-testid="preferences-github-token"
                      placeholder={
                        keyPresence.github ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
                      }
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={() => handleSaveProviderKey('github')}
                      disabled={!keyInputs.github || !!keySaving.github}
                      data-testid="preferences-save-token"
                    >
                      {keySaving.github ? t('common.saving') : t('common.save')}
                    </Button>
                    {keyPresence.github && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleClearProviderKey('github')}
                        disabled={!!keySaving.github}
                        data-testid="preferences-clear-token"
                      >
                        {t('profile.clearToken')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {activePreferencesPage === 'ai-keys' && (
            <>
              <h3 className="settings-section-header">AI Providers</h3>
              <p className="px-1 pb-3 text-xs text-muted-foreground">
                Configure API keys for AI providers. Keys are encrypted at rest.
              </p>
              <div className="settings-card space-y-0 divide-y divide-border">
                {PROVIDER_KEY_REGISTRY.filter(
                  (k) => k.id !== 'github' && k.id !== 'assemblyai',
                ).map((keyConfig) => (
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
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        value={keyInputs[keyConfig.id] ?? ''}
                        onChange={(e) =>
                          setKeyInputs((prev) => ({ ...prev, [keyConfig.id]: e.target.value }))
                        }
                        data-testid={`preferences-${keyConfig.id}-key`}
                        placeholder={
                          keyPresence[keyConfig.id]
                            ? t('profile.tokenSaved')
                            : `Enter your ${keyConfig.label}`
                        }
                        className="text-sm"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSaveProviderKey(keyConfig.id)}
                        disabled={!keyInputs[keyConfig.id] || !!keySaving[keyConfig.id]}
                        data-testid={`preferences-save-${keyConfig.id}-key`}
                      >
                        {keySaving[keyConfig.id] ? t('common.saving') : t('common.save')}
                      </Button>
                      {keyPresence[keyConfig.id] && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 text-xs text-destructive hover:text-destructive"
                          onClick={() => handleClearProviderKey(keyConfig.id)}
                          disabled={!!keySaving[keyConfig.id]}
                          data-testid={`preferences-clear-${keyConfig.id}-key`}
                        >
                          {t('profile.clearToken')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
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
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      value={keyInputs.assemblyai ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, assemblyai: e.target.value }))
                      }
                      data-testid="preferences-assemblyai-key"
                      placeholder={
                        keyPresence.assemblyai
                          ? t('profile.tokenSaved')
                          : 'Enter your AssemblyAI API key'
                      }
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={() => handleSaveProviderKey('assemblyai')}
                      disabled={!keyInputs.assemblyai || !!keySaving.assemblyai}
                      data-testid="preferences-save-assemblyai-key"
                    >
                      {keySaving.assemblyai ? t('common.saving') : t('common.save')}
                    </Button>
                    {keyPresence.assemblyai && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleClearProviderKey('assemblyai')}
                        disabled={!!keySaving.assemblyai}
                        data-testid="preferences-clear-assemblyai-key"
                      >
                        {t('profile.clearToken')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {activePreferencesPage === 'organizations' && <OrganizationManagement />}

          {activePreferencesPage === 'runners' && <RunnersSettings />}

          {activePreferencesPage === 'agent-templates' && <AgentTemplateSettings />}

          {activePreferencesPage === 'system' && <SystemSettings />}

          {activePreferencesPage === 'email' && (
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
                Used for sending team invitation emails. Set via env vars (SMTP_HOST, SMTP_USER,
                SMTP_PASS) or configure below.
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
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
