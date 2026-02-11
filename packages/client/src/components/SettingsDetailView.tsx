import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, editorLabels, type Theme, type Editor, type ThreadMode } from '@/stores/settings-store';
import { settingsItems, settingsLabelKeys, type SettingsItemId } from './SettingsPanel';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Sun, Moon, Monitor, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { McpServerSettings } from './McpServerSettings';
import { SkillsSettings } from './SkillsSettings';
import { WorktreeSettings } from './WorktreeSettings';
import { StartupCommandsSettings } from './StartupCommandsSettings';
import { AutomationSettings } from './AutomationSettings';
import { ArchivedThreadsSettings } from './ArchivedThreadsSettings';

function getLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

/* ── Reusable setting row ── */
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
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

/* ── Segmented control (for theme) ── */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── General settings content ── */
function GeneralSettings() {
  const { theme, defaultEditor, defaultThreadMode, defaultPrompt, setTheme, setDefaultEditor, setDefaultThreadMode, setDefaultPrompt } = useSettingsStore();
  const { t, i18n } = useTranslation();

  return (
    <>
      {/* General section */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
        {t('settings.general')}
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden mb-6">
        <SettingRow
          title={t('settings.defaultEditor')}
          description={t('settings.defaultEditorDesc')}
        >
          <Select value={defaultEditor} onValueChange={(v) => setDefaultEditor(v as Editor)}>
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
          title={t('settings.language')}
          description={t('settings.languageDesc')}
        >
          <Select value={i18n.language} onValueChange={(v) => i18n.changeLanguage(v)}>
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
      </div>

      {/* Appearance section */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
        {t('settings.appearance')}
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <SettingRow
          title={t('settings.theme')}
          description={t('settings.themeDesc')}
        >
          <SegmentedControl<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: t('settings.light'), icon: <Sun className="h-3 w-3" /> },
              { value: 'dark', label: t('settings.dark'), icon: <Moon className="h-3 w-3" /> },
              { value: 'system', label: t('settings.system'), icon: <Monitor className="h-3 w-3" /> },
            ]}
          />
        </SettingRow>
      </div>

      {/* Threads section */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2 mt-6">
        {t('settings.threads')}
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <SettingRow
          title={t('settings.defaultThreadMode')}
          description={t('settings.defaultThreadModeDesc')}
        >
          <SegmentedControl<ThreadMode>
            value={defaultThreadMode}
            onChange={setDefaultThreadMode}
            options={[
              { value: 'local', label: t('thread.mode.local'), icon: <Monitor className="h-3 w-3" /> },
              { value: 'worktree', label: t('thread.mode.worktree'), icon: <GitBranch className="h-3 w-3" /> },
            ]}
          />
        </SettingRow>
      </div>

      {/* Default prompt */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2 mt-6">
        {t('settings.prompt')}
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <div className="px-4 py-3.5">
          <p className="text-sm font-medium text-foreground">{t('settings.defaultPrompt')}</p>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">{t('settings.defaultPromptDesc')}</p>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground min-h-[80px] resize-y transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('settings.defaultPromptPlaceholder')}
            value={defaultPrompt}
            onChange={(e) => setDefaultPrompt(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}

export function SettingsDetailView() {
  const { t } = useTranslation();
  const activeSettingsPage = useAppStore(s => s.activeSettingsPage);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const page = activeSettingsPage as SettingsItemId | null;
  const label = page ? t(settingsLabelKeys[page] ?? page) : null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  if (!page) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        {t('settings.selectSetting')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      {/* Page header */}
      <div className="px-4 py-2 border-b border-border">
        <Breadcrumb>
          <BreadcrumbList>
            {selectedProject && (
              <BreadcrumbItem>
                <BreadcrumbLink className="text-sm truncate cursor-default">
                  {selectedProject.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {selectedProject && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <BreadcrumbPage className="text-sm truncate">
                {label}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Page content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 py-8 max-w-2xl">
          {page === 'general' ? (
            <GeneralSettings />
          ) : page === 'mcp-server' ? (
            <McpServerSettings />
          ) : page === 'skills' ? (
            <SkillsSettings />
          ) : page === 'worktrees' ? (
            <WorktreeSettings />
          ) : page === 'startup-commands' ? (
            <StartupCommandsSettings />
          ) : page === 'automations' ? (
            <AutomationSettings />
          ) : page === 'archived-threads' ? (
            <ArchivedThreadsSettings />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('settings.comingSoon', { label })}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
