import type { AgentProvider, ToolPermission } from '@funny/shared';
import { DEFAULT_FOLLOW_UP_MODE, DEFAULT_PROVIDER, getDefaultModel } from '@funny/shared/models';
import { GitBranch, Monitor, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { ModelCombobox } from '@/components/general-settings-project/ModelCombobox';
import {
  DefaultTemplateSetting,
  LauncherUrlSetting,
  ProjectSystemPrompt,
  ProjectUrlPatterns,
  WeaveStatusSetting,
} from '@/components/general-settings-project/project-section-rows';
import { ProjectColorPicker } from '@/components/general-settings-project/ProjectColorPicker';
import { ProjectPathSetting } from '@/components/general-settings-project/ProjectPathSetting';
import {
  SegmentedControl,
  SettingRow,
} from '@/components/general-settings-project/setting-primitives';
import { projectsApi } from '@/lib/api/projects';
import { getModelOptions, PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { usePiModelsStore } from '@/stores/pi-models-store';
import { useProjectStore } from '@/stores/project-store';
import { ALL_STANDARD_TOOLS, TOOL_LABELS, useSettingsStore } from '@/stores/settings-store';

import { BranchPicker } from './SearchablePicker';

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
      const result = await updateProject(projectId, data);
      if (result.isErr()) {
        toast.error(result.error.message, { id: 'project-settings-saved' });
        return;
      }
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
            <ProjectPathSetting projectId={selectedProject.id} currentPath={selectedProject.path} />
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
