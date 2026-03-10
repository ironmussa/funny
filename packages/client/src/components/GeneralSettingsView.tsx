import type { UserProfile } from '@funny/shared';
import { ArrowLeft, Check, Github, Mail, Palette, Send, SlidersHorizontal } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  useSettingsStore,
  editorLabels,
  shellLabels,
  type Editor,
  type TerminalShell,
} from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import { SettingRow } from './settings/SettingRow';

type GeneralPage = 'general' | 'appearance' | 'github' | 'email';

const NAV_ITEMS: Array<{ id: GeneralPage; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'general', label: 'settings.general', icon: SlidersHorizontal },
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'email', label: 'Email (SMTP)', icon: Mail },
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
        {selected && <Check className="h-3 w-3 text-primary" />}
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
    setDefaultEditor,
    setUseInternalEditor,
    setTerminalShell,
  } = useSettingsStore(
    useShallow((s) => ({
      defaultEditor: s.defaultEditor,
      useInternalEditor: s.useInternalEditor,
      terminalShell: s.terminalShell,
      setDefaultEditor: s.setDefaultEditor,
      setUseInternalEditor: s.setUseInternalEditor,
      setTerminalShell: s.setTerminalShell,
    })),
  );
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;

  // GitHub token state
  const [githubToken, setGithubToken] = useState('');
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);

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
        setHasGithubToken((result.value as UserProfile).hasGithubToken);
      }
    });
    setGithubToken('');
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
  }, []);

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

  const handleLanguageChange = useCallback(
    (code: string) => {
      i18n.changeLanguage(code);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [i18n, t],
  );

  // GitHub token handlers
  const handleSaveToken = useCallback(async () => {
    if (!githubToken) return;
    setTokenSaving(true);
    const result = await api.updateProfile({ githubToken });
    if (result.isOk()) {
      setHasGithubToken(result.value.hasGithubToken);
      setGithubToken('');
      toast.success(t('profile.tokenSaved'));
    } else {
      toast.error(t('profile.saveFailed'));
    }
    setTokenSaving(false);
  }, [githubToken, t]);

  const handleClearToken = useCallback(async () => {
    setTokenSaving(true);
    const result = await api.updateProfile({ githubToken: null });
    if (result.isOk()) {
      setHasGithubToken(false);
      setGithubToken('');
      toast.success(t('profile.tokenCleared'));
    }
    setTokenSaving(false);
  }, [t]);

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
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                useUIStore.getState().setGeneralSettingsOpen(false);
                navigate('/');
              }}
              className="text-muted-foreground hover:text-foreground"
              data-testid="preferences-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
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
                    onClick={() => navigate(`/preferences/${item.id}`)}
                    data-testid={`preferences-nav-${item.id}`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label.startsWith('settings.') ? t(item.label) : item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>

      {/* Right content area */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6 max-w-2xl">
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
                  <SelectTrigger
                    className="w-[140px]"
                    data-testid="preferences-language-select"
                  >
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
                  <SelectTrigger className="w-[140px]" data-testid="preferences-shell-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(shellLabels) as [TerminalShell, string][]).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label.startsWith('settings.') ? t(label) : label}
                        </SelectItem>
                      ),
                    )}
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
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    data-testid="preferences-github-token"
                    placeholder={
                      hasGithubToken ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
                    }
                    className="text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveToken}
                    disabled={!githubToken || tokenSaving}
                    data-testid="preferences-save-token"
                  >
                    {tokenSaving ? t('common.saving') : t('common.save')}
                  </Button>
                  {hasGithubToken && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs text-destructive hover:text-destructive"
                      onClick={handleClearToken}
                      disabled={tokenSaving}
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
                    <Mail className="mr-1.5 h-3.5 w-3.5" />
                    {smtpSaving ? 'Saving...' : 'Save SMTP'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTestSmtp}
                    disabled={smtpSource === 'none' || smtpTesting}
                    data-testid="preferences-smtp-test"
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    {smtpTesting ? 'Sending...' : 'Send Test Email'}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
