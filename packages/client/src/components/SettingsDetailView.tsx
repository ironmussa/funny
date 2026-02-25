import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/ui-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, ALL_STANDARD_TOOLS, TOOL_LABELS } from '@/stores/settings-store';
import type { ToolPermission } from '@funny/shared';
import { settingsItems, settingsLabelKeys, type SettingsItemId } from './SettingsPanel';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Monitor, GitBranch, RotateCcw, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import type { AgentProvider } from '@funny/shared';
import { getDefaultModel } from '@funny/shared/models';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { McpServerSettings } from './McpServerSettings';
import { SkillsSettings } from './SkillsSettings';
import { WorktreeSettings } from './WorktreeSettings';
import { StartupCommandsSettings } from './StartupCommandsSettings';
import { AutomationSettings } from './AutomationSettings';
import { ArchivedThreadsSettings } from './ArchivedThreadsSettings';
import { UserManagement } from './settings/UserManagement';
import { ProfileSettings } from './settings/ProfileSettings';

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
          aria-pressed={value === opt.value}
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
          className="w-[160px] justify-between text-xs h-8"
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
                      value === opt.value ? 'opacity-100' : 'opacity-0'
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
function ProjectColorPicker({ projectId, currentColor }: { projectId: string; currentColor?: string }) {
  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Project Color</p>
        <p className="text-xs text-muted-foreground mt-0.5">Pick any color for this project</p>
      </div>
      {/* Preset pastel colors */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => updateProject(projectId, { color: null })}
          className={cn(
            'h-7 w-7 rounded-md border-2 transition-all flex items-center justify-center',
            !currentColor
              ? 'border-primary shadow-sm'
              : 'border-border hover:border-muted-foreground'
          )}
          aria-label="No color"
          aria-pressed={!currentColor}
        >
          <div className="h-4 w-4 rounded-sm bg-gradient-to-br from-muted-foreground/20 to-muted-foreground/40" />
        </button>
        {PASTEL_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => updateProject(projectId, { color })}
            className={cn(
              'h-7 w-7 rounded-md border-2 transition-all',
              currentColor === color
                ? 'border-primary shadow-sm scale-110'
                : 'border-transparent hover:border-muted-foreground'
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
            onChange={(e) => updateProject(projectId, { color: e.target.value })}
            aria-label="Custom color picker"
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div
            className={cn(
              'h-8 w-8 rounded-lg border-2 shadow-sm cursor-pointer transition-all hover:scale-105',
              currentColor ? 'border-primary/50' : 'border-border'
            )}
            style={{ backgroundColor: currentColor || 'transparent' }}
          >
            {!currentColor && (
              <div className="h-full w-full rounded-md bg-gradient-to-br from-muted-foreground/10 to-muted-foreground/30 flex items-center justify-center">
                <span className="text-xs text-muted-foreground">—</span>
              </div>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
          Custom color
        </span>
        {currentColor && (
          <span className="text-xs font-mono text-muted-foreground">
            {currentColor}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── General settings content ── */
function GeneralSettings() {
  const { toolPermissions, setToolPermission, resetToolPermissions } = useSettingsStore(useShallow(s => ({
    toolPermissions: s.toolPermissions,
    setToolPermission: s.setToolPermission,
    resetToolPermissions: s.resetToolPermissions,
  })));
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const updateProject = useProjectStore((s) => s.updateProject);
  const { t } = useTranslation();

  return (
    <>
      {/* Project section (only shown when a project is selected) */}
      {selectedProject && (
        <>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
            Project
          </h3>
          <div className="rounded-lg border border-border/50 overflow-hidden mb-6">
            <ProjectColorPicker projectId={selectedProject.id} currentColor={selectedProject.color} />
            <SettingRow
              title={t('settings.followUpMode')}
              description={t('settings.followUpModeDesc')}
            >
              <SegmentedControl<string>
                value={selectedProject.followUpMode || 'interrupt'}
                onChange={(v) => updateProject(selectedProject.id, { followUpMode: v })}
                options={[
                  { value: 'interrupt', label: t('settings.followUpInterrupt') },
                  { value: 'queue', label: t('settings.followUpQueue') },
                ]}
              />
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultModel', 'Default Model')}
              description={t('settings.projectDefaultModelDesc', 'Provider and model for new threads in this project')}
            >
              <div className="flex items-center gap-2">
                <ModelCombobox
                  value={selectedProject.defaultProvider || 'claude'}
                  onChange={(v) => {
                    const p = v as AgentProvider;
                    updateProject(selectedProject.id, {
                      defaultProvider: p,
                      defaultModel: getDefaultModel(p),
                    });
                  }}
                  options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
                  placeholder={t('settings.selectProvider')}
                  searchPlaceholder={t('settings.searchProvider')}
                />
                <ModelCombobox
                  value={selectedProject.defaultModel || getDefaultModel((selectedProject.defaultProvider || 'claude') as AgentProvider)}
                  onChange={(v) => updateProject(selectedProject.id, { defaultModel: v })}
                  options={getModelOptions(selectedProject.defaultProvider || 'claude', t)}
                  placeholder={t('settings.selectModel')}
                  searchPlaceholder={t('settings.searchModel')}
                />
              </div>
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultMode', 'Default Thread Mode')}
              description={t('settings.projectDefaultModeDesc', 'Local or worktree for new threads')}
            >
              <SegmentedControl<string>
                value={selectedProject.defaultMode || 'worktree'}
                onChange={(v) => updateProject(selectedProject.id, { defaultMode: v })}
                options={[
                  { value: 'local', label: t('thread.mode.local'), icon: <Monitor className="h-3 w-3" /> },
                  { value: 'worktree', label: t('thread.mode.worktree'), icon: <GitBranch className="h-3 w-3" /> },
                ]}
              />
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultPermission', 'Default Permission Mode')}
              description={t('settings.projectDefaultPermissionDesc', 'Permission mode for new threads')}
            >
              <SegmentedControl<string>
                value={selectedProject.defaultPermissionMode || 'autoEdit'}
                onChange={(v) => updateProject(selectedProject.id, { defaultPermissionMode: v })}
                options={[
                  { value: 'plan', label: t('prompt.plan') },
                  { value: 'autoEdit', label: t('prompt.autoEdit') },
                  { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
                ]}
              />
            </SettingRow>
          </div>
        </>
      )}

      {/* Permissions */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2 mt-6">
        {t('settings.permissions')}
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <div className="px-4 py-3.5">
          <p className="text-sm font-medium text-foreground">{t('settings.toolPermissions')}</p>
          <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('settings.toolPermissionsDesc')}</p>
          <div className="space-y-1">
            {ALL_STANDARD_TOOLS.map((tool) => (
              <div
                key={tool}
                className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-foreground font-mono">{tool}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(TOOL_LABELS[tool] ?? tool)}
                  </span>
                </div>
                <SegmentedControl<ToolPermission>
                  value={toolPermissions[tool] ?? 'allow'}
                  onChange={(v) => setToolPermission(tool, v)}
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
              onClick={() => resetToolPermissions()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
  const activeSettingsPage = useUIStore(s => s.activeSettingsPage);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const projects = useProjectStore(s => s.projects);
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
        <div className="px-8 py-8 max-w-4xl">
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
          ) : page === 'profile' ? (
            <ProfileSettings />
          ) : page === 'users' ? (
            <UserManagement />
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
