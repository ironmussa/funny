import { Check } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { PromptModelVisibilitySettings } from '@/components/PromptModelVisibilitySettings';
import { SettingRow } from '@/components/settings/SettingRow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateProfile } from '@/data/profile/actions';
import { cn } from '@/lib/utils';
import { type FontSize, type ThreadViewer, useSettingsStore } from '@/stores/settings-store';

import { toastSettingsSaved } from './preferences-hooks';

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

function ThemeGrid() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const activeTheme = theme ?? 'one-dark';

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value);
      void updateProfile({ theme: value });
      toastSettingsSaved(t);
    },
    [setTheme, t],
  );

  return (
    <div className="grid grid-cols-3 gap-2">
      {THEME_OPTIONS.map((opt) => (
        <ThemeCard
          key={opt.value}
          option={opt}
          selected={activeTheme === opt.value}
          onClick={() => handleThemeChange(opt.value)}
          t={t}
        />
      ))}
    </div>
  );
}

function FontSizeCard() {
  const { t } = useTranslation();
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  const handleFontSizeChange = useCallback(
    (v: string) => {
      setFontSize(v as FontSize);
      toastSettingsSaved(t);
    },
    [setFontSize, t],
  );

  return (
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
  );
}

function ThreadViewerCard() {
  const { t } = useTranslation();
  const threadViewer = useSettingsStore((s) => s.threadViewer);
  const setThreadViewer = useSettingsStore((s) => s.setThreadViewer);

  return (
    <div className="settings-card">
      <SettingRow
        title={t('settings.threadViewer', 'Thread viewer')}
        description={t(
          'settings.threadViewerDesc',
          'Frozen renders messages in normal document flow (native scroll, find-in-page across the whole thread). Virtual is the current renderer.',
        )}
      >
        <Select value={threadViewer} onValueChange={(v) => setThreadViewer(v as ThreadViewer)}>
          <SelectTrigger className="w-[140px]" data-testid="preferences-thread-viewer-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="virtual">
              {t('settings.threadViewerVirtual', 'Virtual (default)')}
            </SelectItem>
            <SelectItem value="frozen">
              {t('settings.threadViewerFrozen', 'Frozen (experimental)')}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}

/** Settings > Appearance: theme, font size and the experimental thread viewer. */
export function AppearancePreferencesSection() {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-muted-foreground px-1 pb-3 text-sm">{t('settings.themeDesc')}</p>
      <ThemeGrid />
      <h3 className="settings-section-header mt-6">{t('settings.fontSize')}</h3>
      <FontSizeCard />
      <h3 className="settings-section-header mt-6">{t('settings.experimental', 'Experimental')}</h3>
      <ThreadViewerCard />
    </>
  );
}

/** Settings > Models: which models the prompt picker offers. */
export function ModelsPreferencesSection() {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-muted-foreground px-1 pb-3 text-sm">
        {t('settings.promptModelVisibilityDesc')}
      </p>
      <div className="settings-card overflow-visible!">
        <PromptModelVisibilitySettings showHeader={false} />
      </div>
    </>
  );
}
