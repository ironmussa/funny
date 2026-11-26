import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DefaultTemplateSetting,
  LauncherUrlSetting,
  ProjectSystemPrompt,
  ProjectUrlPatterns,
  WeaveStatusSetting,
} from '@/components/general-settings-project/project-section-rows';
import { ProjectColorPicker } from '@/components/general-settings-project/ProjectColorPicker';
import { ProjectDefaultModelSetting } from '@/components/general-settings-project/ProjectDefaultModelSetting';
import { ProjectPathSetting } from '@/components/general-settings-project/ProjectPathSetting';
import { ProjectRedirectChecksSetting } from '@/components/general-settings-project/ProjectRedirectChecksSetting';
import { ProjectSandboxSetting } from '@/components/general-settings-project/ProjectSandboxSetting';
import { ProjectThreadModeSetting } from '@/components/general-settings-project/ProjectThreadModeSetting';
import {
  SegmentedControl,
  ProjectSettingRow,
} from '@/components/general-settings-project/setting-primitives';
import { ToolPermissionsSection } from '@/components/general-settings/ToolPermissionsSection';
import { toast } from '@/components/ui/toast';
import { useProjects } from '@/data/projects/hooks';
import { projectsApi } from '@/lib/api/projects';
import { useProjectStore } from '@/stores/project-store';

import { BranchPicker } from './SearchablePicker';

/* ── General settings content ── */
export function GeneralSettings() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
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

  // Branch selector state for project default branch
  const [settingsBranches, setSettingsBranches] = useState<string[]>([]);

  // Keyed on the id: the project object is a new one on every render.
  const branchProjectId = selectedProject?.id;
  useEffect(() => {
    if (branchProjectId !== undefined) {
      projectsApi.listBranches(branchProjectId).then((result) => {
        if (result.isOk()) {
          setSettingsBranches(result.value.branches);
        }
      });
    }
  }, [branchProjectId]);

  return (
    <>
      {/* Project section (only shown when a project is selected) */}
      {selectedProject && (
        <>
          <h3 className="text-muted-foreground px-1 pb-2 text-xs font-semibold tracking-wider uppercase">
            Project
          </h3>
          <div className="border-border/50 mb-6 overflow-hidden rounded-lg border">
            <ProjectPathSetting projectId={selectedProject.id} currentPath={selectedProject.path} />
            <ProjectColorPicker
              projectId={selectedProject.id}
              currentColor={selectedProject.color}
              onSave={saveProject}
            />
            <ProjectSettingRow
              settingId="project-general.follow-up-mode"
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
                    value: 'steer',
                    label: t('settings.followUpSteer'),
                    testId: 'settings-followup-steer',
                  },
                ]}
              />
            </ProjectSettingRow>
            <ProjectSettingRow
              settingId="project-general.fast-mode"
              title={t('settings.fastMode')}
              description={t('settings.fastModeDesc')}
            >
              <SegmentedControl<string>
                value={selectedProject.fastMode ? 'on' : 'off'}
                onChange={(v) => saveProject(selectedProject.id, { fastMode: v === 'on' })}
                options={[
                  {
                    value: 'off',
                    label: t('settings.fastModeOff'),
                    testId: 'settings-fastmode-off',
                  },
                  {
                    value: 'on',
                    label: t('settings.fastModeOn'),
                    testId: 'settings-fastmode-on',
                  },
                ]}
              />
            </ProjectSettingRow>
            <ProjectRedirectChecksSetting project={selectedProject} onSave={saveProject} />
            <ProjectDefaultModelSetting project={selectedProject} onSave={saveProject} />
            <ProjectThreadModeSetting projectId={selectedProject.id} />
            <ProjectSettingRow
              settingId="project-general.permission-mode"
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
            </ProjectSettingRow>
            <ProjectSettingRow
              settingId="project-general.default-branch"
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
            </ProjectSettingRow>
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
            <ProjectSandboxSetting projectId={selectedProject.id} />
            <DefaultTemplateSetting
              projectId={selectedProject.id}
              currentTemplateId={selectedProject.defaultAgentTemplateId}
              onSave={saveProject}
            />
          </div>
        </>
      )}

      {/* Permissions */}
      <ToolPermissionsSection />
    </>
  );
}
