import type { UserProfile } from '@funny/shared';
import { Check } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  useSettingsStore,
  editorLabels,
  shellLabels,
  type Editor,
  type TerminalShell,
} from '@/stores/settings-store';

function getLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
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
    colors: { bg: '#282c34', sidebar: '#21252b', accent: '#528bff', fg: '#abb2bf' },
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
      className={cn(
        'relative flex flex-col overflow-hidden rounded-lg border-2 transition-colors',
        selected ? 'border-primary' : 'border-border/50 hover:border-border',
      )}
    >
      {/* Mini preview */}
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

export function GeneralSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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

  // Local draft state — only committed to the store on Save
  const [draftEditor, setDraftEditor] = useState<Editor>(defaultEditor);
  const [draftUseInternalEditor, setDraftUseInternalEditor] = useState(useInternalEditor);
  const [draftShell, setDraftShell] = useState<TerminalShell>(terminalShell);
  const [draftTheme, setDraftTheme] = useState(theme ?? 'one-dark');
  const [draftLanguage, setDraftLanguage] = useState(i18n.language);

  // GitHub token state (persisted via profile API, not local store)
  const [githubToken, setGithubToken] = useState('');
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);

  // Reset draft state whenever the dialog opens
  useEffect(() => {
    if (open) {
      setDraftEditor(defaultEditor);
      setDraftUseInternalEditor(useInternalEditor);
      setDraftShell(terminalShell);
      setDraftTheme(theme ?? 'one-dark');
      setDraftLanguage(i18n.language);
      // Load profile to check token status
      api.getProfile().then((result) => {
        if (result.isOk() && result.value) {
          setHasGithubToken((result.value as UserProfile).hasGithubToken);
        }
      });
      setGithubToken('');
    }
  }, [open, defaultEditor, useInternalEditor, terminalShell, theme, i18n.language]);

  const handleSave = useCallback(async () => {
    setDefaultEditor(draftEditor);
    setUseInternalEditor(draftUseInternalEditor);
    setTerminalShell(draftShell);
    setTheme(draftTheme);
    i18n.changeLanguage(draftLanguage);
    // Save GitHub token if user typed one
    if (githubToken) {
      const result = await api.updateProfile({ githubToken } as any);
      if (result.isOk()) {
        setHasGithubToken(result.value.hasGithubToken);
        setGithubToken('');
      } else {
        toast.error(t('profile.saveFailed'));
      }
    }
    onOpenChange(false);
  }, [
    draftEditor,
    draftUseInternalEditor,
    draftShell,
    draftTheme,
    draftLanguage,
    githubToken,
    setDefaultEditor,
    setUseInternalEditor,
    setTerminalShell,
    setTheme,
    i18n,
    t,
    onOpenChange,
  ]);

  const handleClearToken = useCallback(async () => {
    setTokenSaving(true);
    const result = await api.updateProfile({ githubToken: null } as any);
    if (result.isOk()) {
      setHasGithubToken(false);
      setGithubToken('');
      toast.success(t('profile.tokenCleared'));
    }
    setTokenSaving(false);
  }, [t]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col gap-0 p-0">
        <DialogHeader className="flex-shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
          {/* General section */}
          <div>
            <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings.general')}
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/50">
              <SettingRow
                title={t('settings.defaultEditor')}
                description={t('settings.defaultEditorDesc')}
              >
                <Select value={draftEditor} onValueChange={(v) => setDraftEditor(v as Editor)}>
                  <SelectTrigger className="w-[140px]">
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
                  checked={draftUseInternalEditor}
                  onCheckedChange={(checked) => setDraftUseInternalEditor(!!checked)}
                />
              </SettingRow>

              <SettingRow title={t('settings.language')} description={t('settings.languageDesc')}>
                <Select value={draftLanguage} onValueChange={setDraftLanguage}>
                  <SelectTrigger className="w-[140px]">
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
                <Select value={draftShell} onValueChange={(v) => setDraftShell(v as TerminalShell)}>
                  <SelectTrigger className="w-[140px]">
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
          </div>

          {/* Appearance section */}
          <div>
            <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings.appearance')}
            </h3>
            <p className="px-1 pb-3 text-xs text-muted-foreground">{t('settings.themeDesc')}</p>
            <div className="grid grid-cols-2 gap-2">
              {THEME_OPTIONS.map((opt) => (
                <ThemeCard
                  key={opt.value}
                  option={opt}
                  selected={draftTheme === opt.value}
                  onClick={() => setDraftTheme(opt.value)}
                  t={t}
                />
              ))}
            </div>
          </div>

          {/* GitHub section */}
          <div>
            <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              GitHub
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/50">
              <div className="px-4 py-3.5">
                <p className="text-sm font-medium text-foreground">
                  {t('profile.githubTokenLabel')}
                </p>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  {t('profile.githubTokenDesc')}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder={
                      hasGithubToken ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
                    }
                    className="text-sm"
                  />
                  {hasGithubToken && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs text-destructive hover:text-destructive"
                      onClick={handleClearToken}
                      disabled={tokenSaving}
                    >
                      {t('profile.clearToken')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 border-t border-border/50 px-6 py-4">
          <Button variant="outline" onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
