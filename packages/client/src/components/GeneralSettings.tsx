import type { ToolPermission, AgentProvider } from '@funny/shared';
import { getDefaultModel, DEFAULT_PROVIDER, DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import {
  Monitor,
  GitBranch,
  RotateCcw,
  Check,
  ChevronsUpDown,
  X,
  Plus,
  MessageSquareText,
  FolderOpen,
} from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from '@/components/ui/color-picker';
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
import { Textarea } from '@/components/ui/textarea';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { projectsApi } from '@/lib/api/projects';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { usePiModelsStore } from '@/stores/pi-models-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, ALL_STANDARD_TOOLS, TOOL_LABELS } from '@/stores/settings-store';

import { FolderPicker } from './FolderPicker';
import { BranchPicker } from './SearchablePicker';

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
          <ChevronsUpDown className="icon-xs ml-1 shrink-0 opacity-50" />
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

/* ── Project path editor ── */
function ProjectPathSetting({
  projectId,
  currentPath,
  onSave,
}: {
  projectId: string;
  currentPath: string;
  onSave: (projectId: string, data: { path: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(currentPath);
  }, [currentPath]);

  const dirty = value.trim() !== currentPath && value.trim().length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(projectId, { path: value.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border/50 px-4 py-3.5 last:border-b-0">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t('settings.projectPath', 'Project Path')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'settings.projectPathDesc',
              'Absolute path to the git repository. Existing threads keep their original worktrees; new threads will use the updated path.',
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            data-testid="settings-project-path"
            className="flex-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="/absolute/path/to/repo"
          />
          <TooltipIconButton
            data-testid="settings-project-path-browse"
            variant="outline"
            size="icon"
            onClick={() => setPickerOpen(true)}
            tooltip={t('sidebar.browseFolder', 'Browse folder')}
            aria-label={t('sidebar.browseFolder', 'Browse folder')}
          >
            <FolderOpen className="icon-base" />
          </TooltipIconButton>
          <Button
            data-testid="settings-project-path-save"
            size="sm"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? t('common.loading', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </div>
      </div>
      {pickerOpen && (
        <FolderPicker
          onSelect={(p) => {
            setValue(p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

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
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Open custom color picker"
              data-testid="project-color-custom-trigger"
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
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="start">
            <ColorPicker
              value={currentColor || '#7CB9E8'}
              onChange={([r, g, b]) => {
                const hex =
                  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
                onSave(projectId, { color: hex });
              }}
            >
              <ColorPickerSelection className="h-40 rounded-lg" />
              <ColorPickerHue />
              <ColorPickerAlpha />
              <div className="flex items-center gap-2">
                <ColorPickerEyeDropper />
                <ColorPickerOutput />
                <ColorPickerFormat />
              </div>
            </ColorPicker>
          </PopoverContent>
        </Popover>
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
            <TooltipIconButton
              size="icon-sm"
              className="shrink-0"
              onClick={() => {
                const next = urls.filter((_, idx) => idx !== i);
                save(next);
              }}
              tooltip={t('common.delete')}
            >
              <X className="icon-sm" />
            </TooltipIconButton>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setUrls([...urls, ''])}
          data-testid="settings-url-pattern-add"
        >
          <Plus className="icon-xs mr-1.5" />
          {t('settings.addUrl', 'Add URL')}
        </Button>
      </div>
    </div>
  );
}

/* ── Project system prompt ── */
function ProjectSystemPrompt({
  projectId,
  currentPrompt,
  onSave,
}: {
  projectId: string;
  currentPrompt?: string;
  onSave: (projectId: string, data: { systemPrompt: string | null }) => void;
}) {
  const [value, setValue] = useState(currentPrompt || '');
  const { t } = useTranslation();

  useEffect(() => {
    setValue(currentPrompt || '');
  }, [currentPrompt]);

  const save = () => {
    const trimmed = value.trim();
    onSave(projectId, { systemPrompt: trimmed || null });
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <MessageSquareText className="icon-base text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t('settings.systemPrompt', 'System Prompt')}
          </p>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            'settings.systemPromptDesc',
            'Custom instructions prepended to every agent message in this project. Use this for project-specific conventions, coding standards, or context.',
          )}
        </p>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder={t(
          'settings.systemPromptPlaceholder',
          "e.g. Always use TypeScript strict mode. Follow the repository's existing patterns...",
        )}
        className="min-h-[120px] resize-y font-mono text-xs"
        data-testid="settings-system-prompt"
      />
    </div>
  );
}

/* ── Podman launcher URL ── */
function LauncherUrlSetting({
  projectId,
  currentUrl,
  onSave,
}: {
  projectId: string;
  currentUrl?: string;
  onSave: (projectId: string, data: { launcherUrl: string | null }) => void;
}) {
  const [value, setValue] = useState(currentUrl || '');
  const { t } = useTranslation();

  useEffect(() => {
    setValue(currentUrl || '');
  }, [currentUrl]);

  const save = () => {
    const trimmed = value.trim();
    onSave(projectId, { launcherUrl: trimmed || null });
  };

  return (
    <SettingRow
      title={t('settings.launcherUrl', 'Podman Launcher URL')}
      description={t(
        'settings.launcherUrlDesc',
        'URL of the Podman launcher API for remote container execution',
      )}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
        placeholder="http://localhost:4040"
        className="h-8 w-[240px] font-mono text-xs"
        data-testid="settings-launcher-url"
      />
    </SettingRow>
  );
}

/* ── Default Deep Agent template ── */
function DefaultTemplateSetting({
  projectId,
  currentTemplateId,
  onSave,
}: {
  projectId: string;
  currentTemplateId?: string;
  onSave: (id: string, data: Record<string, unknown>) => void;
}) {
  const { templates, initialized, loadTemplates } = useAgentTemplateStore();

  useEffect(() => {
    if (!initialized) loadTemplates();
  }, [initialized, loadTemplates]);

  return (
    <SettingRow
      title="Default Agent Template"
      description="Auto-select this template when creating new Deep Agent threads in this project."
    >
      <select
        className="h-9 rounded-md border border-input bg-background px-3 text-xs"
        value={currentTemplateId ?? ''}
        onChange={(e) => {
          const val = e.target.value || null;
          onSave(projectId, { defaultAgentTemplateId: val });
        }}
        data-testid="settings-default-agent-template"
      >
        <option value="">None</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.id.startsWith('__builtin__') ? `[Built-in] ${tpl.name}` : tpl.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

/* ── Weave semantic merge status ── */
function WeaveStatusSetting({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<import('@funny/shared').WeaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const { t } = useTranslation();

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const result = await projectsApi.getWeaveStatus(projectId);
    if (result.isOk()) {
      setStatus(result.value);
    } else {
      setStatus(null);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleConfigure = async () => {
    setConfiguring(true);
    const result = await projectsApi.configureWeave(projectId);
    if (result.isOk()) {
      setStatus(result.value.status);
      toast.success(t('settings.weaveConfigured', 'Weave semantic merge configured'));
    } else {
      toast.error(t('settings.weaveConfigureFailed', 'Failed to configure Weave'));
    }
    setConfiguring(false);
  };

  if (loading) {
    return (
      <SettingRow
        title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
        description={t(
          'settings.weaveDesc',
          'Reduces false merge conflicts using semantic analysis',
        )}
      >
        <div className="h-8 w-[140px] animate-pulse rounded-md bg-muted" />
      </SettingRow>
    );
  }

  if (!status || status.status === 'not-installed') {
    return (
      <SettingRow
        title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
        description={t(
          'settings.weaveDesc',
          'Reduces false merge conflicts using semantic analysis',
        )}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="settings-weave-status">
            {t('settings.weaveNotInstalled', 'weave-driver not found')}
          </span>
          <a
            href="https://github.com/Ataraxy-Labs/weave"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline"
            data-testid="settings-weave-install-link"
          >
            {t('settings.weaveInstall', 'Install')}
          </a>
        </div>
      </SettingRow>
    );
  }

  return (
    <SettingRow
      title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
      description={t('settings.weaveDesc', 'Reduces false merge conflicts using semantic analysis')}
    >
      <div className="flex items-center gap-3">
        <span
          data-testid="settings-weave-status"
          className={cn(
            'text-xs',
            status.status === 'active' ? 'text-green-500' : 'text-muted-foreground',
          )}
        >
          {status.status === 'active'
            ? t('settings.weaveActive', 'Active')
            : t('settings.weaveUnconfigured', 'Not configured')}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleConfigure}
          disabled={configuring}
          data-testid="settings-weave-configure"
        >
          {configuring
            ? t('settings.weaveConfiguring', 'Configuring...')
            : status.status === 'active'
              ? t('settings.weaveReconfigure', 'Reconfigure')
              : t('settings.weaveConfigure', 'Configure')}
        </Button>
      </div>
    </SettingRow>
  );
}

/* ── General settings content ── */
export function GeneralSettings() {
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

  // Branch selector state for project default branch
  const [settingsBranches, setSettingsBranches] = useState<string[]>([]);

  useEffect(() => {
    if (selectedProject) {
      projectsApi.listBranches(selectedProject.id).then((result) => {
        if (result.isOk()) {
          setSettingsBranches(result.value.branches);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on id only; using selectedProject object would loop
  }, [selectedProject?.id]);

  // Pi model catalog is discovered at runtime (see pi-discover.ts) — fetch on
  // mount so the Settings combobox lists what pi-acp actually advertises (e.g.
  // zai/glm-5.1) instead of just the `default` sentinel from the static registry.
  const piModels = usePiModelsStore((s) => s.models);
  const piStatus = usePiModelsStore((s) => s.status);
  const fetchPiModels = usePiModelsStore((s) => s.fetch);
  useEffect(() => {
    void fetchPiModels();
  }, [fetchPiModels]);

  const projectDefaultProvider = (selectedProject?.defaultProvider ||
    DEFAULT_PROVIDER) as AgentProvider;
  const projectModelOptions = (() => {
    const base = getModelOptions(projectDefaultProvider, t);
    if (projectDefaultProvider !== 'pi' || piStatus !== 'ready') return base;
    const seen = new Set(base.map((o) => o.value));
    for (const m of piModels) {
      if (seen.has(m.modelId)) continue;
      base.push({ value: m.modelId, label: m.name || m.modelId });
      seen.add(m.modelId);
    }
    return base;
  })();

  return (
    <>
      {/* Project section (only shown when a project is selected) */}
      {selectedProject && (
        <>
          <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Project
          </h3>
          <div className="mb-6 overflow-hidden rounded-lg border border-border/50">
            <ProjectPathSetting
              projectId={selectedProject.id}
              currentPath={selectedProject.path}
              onSave={saveProject}
            />
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
                value={selectedProject.followUpMode || DEFAULT_FOLLOW_UP_MODE}
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
                  {
                    value: 'ask',
                    label: t('settings.followUpAsk'),
                    testId: 'settings-followup-ask',
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
                  value={selectedProject.defaultProvider || DEFAULT_PROVIDER}
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
                    getDefaultModel(
                      (selectedProject.defaultProvider || DEFAULT_PROVIDER) as AgentProvider,
                    )
                  }
                  onChange={(v) => saveProject(selectedProject.id, { defaultModel: v })}
                  options={projectModelOptions}
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
                value={selectedProject.defaultMode || 'local'}
                onChange={(v) => saveProject(selectedProject.id, { defaultMode: v })}
                options={[
                  {
                    value: 'local',
                    label: t('thread.mode.local'),
                    icon: <Monitor className="icon-xs" />,
                    testId: 'settings-thread-mode-local',
                  },
                  {
                    value: 'worktree',
                    label: t('thread.mode.worktree'),
                    icon: <GitBranch className="icon-xs" />,
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
                  { value: 'auto', label: t('prompt.auto') },
                  { value: 'autoEdit', label: t('prompt.autoEdit') },
                  { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
                ]}
              />
            </SettingRow>
            <SettingRow
              title={t('settings.projectDefaultBranch', 'Default Branch')}
              description={t(
                'settings.projectDefaultBranchDesc',
                'Branch pre-selected when creating new threads',
              )}
            >
              <BranchPicker
                branches={settingsBranches}
                selected={selectedProject.defaultBranch || ''}
                onChange={(branch) => {
                  const value = branch === '__git_default__' ? null : branch;
                  saveProject(selectedProject.id, { defaultBranch: value });
                }}
                extraItems={[
                  {
                    key: '__git_default__',
                    label: t('settings.gitDefault', 'Git default'),
                    isSelected: !selectedProject.defaultBranch,
                  },
                ]}
                placeholder={t('settings.gitDefault', 'Git default')}
                triggerClassName="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-xs hover:bg-accent/50"
                side="bottom"
                align="end"
                showCopy={false}
                testId="settings-default-branch-trigger"
              />
            </SettingRow>
            <ProjectUrlPatterns
              projectId={selectedProject.id}
              currentUrls={selectedProject.urls || []}
              onSave={saveProject}
            />
            <ProjectSystemPrompt
              projectId={selectedProject.id}
              currentPrompt={selectedProject.systemPrompt}
              onSave={saveProject}
            />
            <LauncherUrlSetting
              projectId={selectedProject.id}
              currentUrl={selectedProject.launcherUrl}
              onSave={saveProject}
            />
            <WeaveStatusSetting projectId={selectedProject.id} />
            <DefaultTemplateSetting
              projectId={selectedProject.id}
              currentTemplateId={selectedProject.defaultAgentTemplateId}
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
              <RotateCcw className="icon-xs" />
              {t('settings.resetDefaults')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
