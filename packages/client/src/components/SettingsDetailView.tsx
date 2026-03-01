import type { ToolPermission } from '@funny/shared';
import type { AgentProvider } from '@funny/shared';
import { getDefaultModel } from '@funny/shared/models';
import { Monitor, GitBranch, RotateCcw, Check, ChevronsUpDown, X, Plus } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, ALL_STANDARD_TOOLS, TOOL_LABELS } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import { ArchivedThreadsSettings } from './ArchivedThreadsSettings';
import { AutomationSettings } from './AutomationSettings';
import { McpServerSettings } from './McpServerSettings';
import { UserManagement } from './settings/UserManagement';
import { settingsLabelKeys, type SettingsItemId } from './SettingsPanel';
import { SkillsSettings } from './SkillsSettings';
import { StartupCommandsSettings } from './StartupCommandsSettings';
import { WorktreeSettings } from './WorktreeSettings';

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
    <div className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
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
  options: { value: T; label: string; icon?: React.ReactNode; testId?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          data-testid={opt.testId}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── Combobox for provider/model selection ── */
function ModelCombobox({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  searchPlaceholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-[160px] justify-between text-xs"
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.label}
                  onSelect={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ── Preset pastel colors ── */
const PASTEL_COLORS = [
  '#7CB9E8', // pastel blue
  '#F4A4A4', // pastel red
  '#A8D5A2', // pastel green
  '#F9D98C', // pastel amber
  '#C3A6E0', // pastel violet
  '#F2A6C8', // pastel pink
  '#89D4CF', // pastel teal
  '#F9B97C', // pastel orange
];

/* ── Color picker area ── */
function ProjectColorPicker({
  projectId,
  currentColor,
  onSave,
}: {
  projectId: string;
  currentColor?: string;
  onSave: (projectId: string, data: { color: string | null }) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Project Color</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Pick any color for this project</p>
      </div>
      {/* Preset pastel colors */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave(projectId, { color: null })}
          className={cn(
            'h-7 w-7 rounded-md border-2 transition-all flex items-center justify-center',
            !currentColor
              ? 'border-primary shadow-sm'
              : 'border-border hover:border-muted-foreground',
          )}
          aria-label="No color"
          aria-pressed={!currentColor}
          data-testid="project-color-none"
        >
          <div className="h-4 w-4 rounded-sm bg-gradient-to-br from-muted-foreground/20 to-muted-foreground/40" />
        </button>
        {PASTEL_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => onSave(projectId, { color })}
            className={cn(
              'h-7 w-7 rounded-md border-2 transition-all',
              currentColor === color
                ? 'border-primary shadow-sm scale-110'
                : 'border-transparent hover:border-muted-foreground',
            )}
            style={{ backgroundColor: color }}
            aria-label={`Color ${color}`}
            aria-pressed={currentColor === color}
          />
        ))}
      </div>
      {/* Custom color picker */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <input
            type="color"
            value={currentColor || '#7CB9E8'}
            onChange={(e) => onSave(projectId, { color: e.target.value })}
            aria-label="Custom color picker"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          <div
            className={cn(
              'h-8 w-8 rounded-lg border-2 shadow-sm cursor-pointer transition-all hover:scale-105',
              currentColor ? 'border-primary/50' : 'border-border',
            )}
            style={{ backgroundColor: currentColor || 'transparent' }}
          >
            {!currentColor && (
              <div className="flex h-full w-full items-center justify-center rounded-md bg-gradient-to-br from-muted-foreground/10 to-muted-foreground/30">
                <span className="text-xs text-muted-foreground">—</span>
              </div>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">Custom color</span>
        {currentColor && (
          <span className="font-mono text-xs text-muted-foreground">{currentColor}</span>
        )}
      </div>
    </div>
  );
}

/* ── URL patterns for Chrome extension auto-detection ── */
function ProjectUrlPatterns({
  projectId,
  currentUrls,
  onSave,
}: {
  projectId: string;
  currentUrls: string[];
  onSave: (projectId: string, data: { urls: string[] | null }) => void;
}) {
  const [urls, setUrls] = useState<string[]>(currentUrls);
  const { t } = useTranslation();

  useEffect(() => {
    setUrls(currentUrls);
  }, [currentUrls]);

  const save = (newUrls: string[]) => {
    const filtered = newUrls.filter((u) => u.trim() !== '');
    setUrls(filtered.length > 0 ? filtered : []);
    onSave(projectId, { urls: filtered.length > 0 ? filtered : null });
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {t('settings.projectUrls', 'Extension URLs')}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            'settings.projectUrlsDesc',
            'URLs for Chrome extension auto-detection. The extension will auto-select this project when you visit a matching URL.',
          )}
        </p>
      </div>
      <div className="space-y-2">
        {urls.map((url, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={url}
              onChange={(e) => {
                const next = [...urls];
                next[i] = e.target.value;
                setUrls(next);
              }}
              onBlur={() => save(urls)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(urls);
              }}
              placeholder="https://example.com"
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                const next = urls.filter((_, idx) => idx !== i);
                save(next);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setUrls([...urls, ''])}
          data-testid="settings-url-pattern-add"
        >
          <Plus className="mr-1.5 h-3 w-3" />
          {t('settings.addUrl', 'Add URL')}
        </Button>
      </div>
    </div>
  );
}

/* ── General settings content ── */
function GeneralSettings() {
  const { toolPermissions, setToolPermission, resetToolPermissions } = useSettingsStore(
    useShallow((s) => ({
      toolPermissions: s.toolPermissions,
      setToolPermission: s.setToolPermission,
      resetToolPermissions: s.resetToolPermissions,
    })),
  );
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const updateProject = useProjectStore((s) => s.updateProject);
  const { t } = useTranslation();

  const saveProject = useCallback(
    async (projectId: string, data: Parameters<typeof updateProject>[1]) => {
      await updateProject(projectId, data);
      toast.success(t('settings.projectSaved'), { id: 'project-settings-saved' });
    },
    [updateProject, t],
  );

  const saveToolPermission = useCallback(
    (toolName: string, permission: ToolPermission) => {
      setToolPermission(toolName, permission);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setToolPermission, t],
  );

  const saveResetToolPermissions = useCallback(() => {
    resetToolPermissions();
    toast.success(t('settings.saved'), { id: 'settings-saved' });
  }, [resetToolPermissions, t]);

  return (
    <>
      {/* Project section (only shown when a project is selected) */}
      {selectedProject && (
        <>
          <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Project
          </h3>
          <div className="mb-6 overflow-hidden rounded-lg border border-border/50">
            <ProjectColorPicker
              projectId={selectedProject.id}
              currentColor={selectedProject.color}
              onSave={saveProject}
            />
            <SettingRow
              title={t('settings.followUpMode')}
              description={t('settings.followUpModeDesc')}
            >
              <SegmentedControl<string>
                value={selectedProject.followUpMode || 'interrupt'}
                onChange={(v) => saveProject(selectedProject.id, { followUpMode: v })}
                options={[
                  {
                    value: 'interrupt',
                    label: t('settings.followUpInterrupt'),
                    testId: 'settings-followup-interrupt',
                  },
                  {
                    value: 'queue',
                    label: t('settings.followUpQueue'),
                    testId: 'settings-followup-queue',
                  },
                ]}
              />
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultModel', 'Default Model')}
              description={t(
                'settings.projectDefaultModelDesc',
                'Provider and model for new threads in this project',
              )}
            >
              <div className="flex items-center gap-2">
                <ModelCombobox
                  value={selectedProject.defaultProvider || 'claude'}
                  onChange={(v) => {
                    const p = v as AgentProvider;
                    saveProject(selectedProject.id, {
                      defaultProvider: p,
                      defaultModel: getDefaultModel(p),
                    });
                  }}
                  options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
                  placeholder={t('settings.selectProvider')}
                  searchPlaceholder={t('settings.searchProvider')}
                />
                <ModelCombobox
                  value={
                    selectedProject.defaultModel ||
                    getDefaultModel((selectedProject.defaultProvider || 'claude') as AgentProvider)
                  }
                  onChange={(v) => saveProject(selectedProject.id, { defaultModel: v })}
                  options={getModelOptions(selectedProject.defaultProvider || 'claude', t)}
                  placeholder={t('settings.selectModel')}
                  searchPlaceholder={t('settings.searchModel')}
                />
              </div>
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultMode', 'Default Thread Mode')}
              description={t(
                'settings.projectDefaultModeDesc',
                'Local or worktree for new threads',
              )}
            >
              <SegmentedControl<string>
                value={selectedProject.defaultMode || 'worktree'}
                onChange={(v) => saveProject(selectedProject.id, { defaultMode: v })}
                options={[
                  {
                    value: 'local',
                    label: t('thread.mode.local'),
                    icon: <Monitor className="h-3 w-3" />,
                    testId: 'settings-thread-mode-local',
                  },
                  {
                    value: 'worktree',
                    label: t('thread.mode.worktree'),
                    icon: <GitBranch className="h-3 w-3" />,
                    testId: 'settings-thread-mode-worktree',
                  },
                ]}
              />
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultPermission', 'Default Permission Mode')}
              description={t(
                'settings.projectDefaultPermissionDesc',
                'Permission mode for new threads',
              )}
            >
              <SegmentedControl<string>
                value={selectedProject.defaultPermissionMode || 'autoEdit'}
                onChange={(v) => saveProject(selectedProject.id, { defaultPermissionMode: v })}
                options={[
                  { value: 'ask', label: t('prompt.ask') },
                  { value: 'plan', label: t('prompt.plan') },
                  { value: 'autoEdit', label: t('prompt.autoEdit') },
                  { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
                ]}
              />
            </SettingRow>
            <ProjectUrlPatterns
              projectId={selectedProject.id}
              currentUrls={selectedProject.urls || []}
              onSave={saveProject}
            />
          </div>
        </>
      )}

      {/* Permissions */}
      <h3 className="mt-6 px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.permissions')}
      </h3>
      <div className="overflow-hidden rounded-lg border border-border/50">
        <div className="px-4 py-3.5">
          <p className="text-sm font-medium text-foreground">{t('settings.toolPermissions')}</p>
          <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
            {t('settings.toolPermissionsDesc')}
          </p>
          <div className="space-y-1">
            {ALL_STANDARD_TOOLS.map((tool) => (
              <div
                key={tool}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-sm text-foreground">{tool}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(TOOL_LABELS[tool] ?? tool)}
                  </span>
                </div>
                <SegmentedControl<ToolPermission>
                  value={toolPermissions[tool] ?? 'allow'}
                  onChange={(v) => saveToolPermission(tool, v)}
                  options={[
                    { value: 'allow', label: t('settings.allow') },
                    { value: 'ask', label: t('settings.ask') },
                    { value: 'deny', label: t('settings.deny') },
                  ]}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => saveResetToolPermissions()}
              data-testid="settings-reset-defaults"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              {t('settings.resetDefaults')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsDetailView() {
  const { t } = useTranslation();
  const activeSettingsPage = useUIStore((s) => s.activeSettingsPage);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const page = activeSettingsPage as SettingsItemId | null;
  const label = page ? t(settingsLabelKeys[page] ?? page) : null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  if (!page) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('settings.selectSetting')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Page header */}
      <div className="border-b border-border px-4 py-2">
        <Breadcrumb>
          <BreadcrumbList>
            {selectedProject && (
              <BreadcrumbItem>
                <BreadcrumbLink className="cursor-default truncate text-sm">
                  {selectedProject.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {selectedProject && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <BreadcrumbPage className="truncate text-sm">{label}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Page content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="max-w-4xl px-8 py-8">
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
          ) : page === 'users' ? (
            <UserManagement />
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.comingSoon', { label })}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
