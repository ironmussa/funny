/**
 * Where the current user's new threads start on a project: the project
 * directory, a worktree, or their sandbox for the project (change
 * project-runtime-settings). The choice is per user and per project, stored in
 * their runtime row; absent means `local`. Every member picks their own,
 * including sandbox (each with their own provider connection, chosen first).
 */
import { Boxes, GitBranch, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanSteerProject } from '@/data/projects/hooks';
import { saveProjectSandbox } from '@/data/runner/actions';
import { useProjectSandbox } from '@/data/runner/hooks';

import { SegmentedControl, ProjectSettingRow } from './setting-primitives';

type ThreadRuntimeMode = 'local' | 'worktree' | 'sandbox';

interface Props {
  projectId: string;
}

function ProjectThreadModeSettingRows({ projectId }: Props) {
  const { t } = useTranslation();
  const { sandbox } = useProjectSandbox(projectId);
  const settings = sandbox?.settings ?? null;

  // Sandbox needs a provider connection on the user's own runtime row.
  const hasConnection = !!settings?.connectionId;
  const value: ThreadRuntimeMode = settings?.mode ?? 'local';

  const onChange = (next: ThreadRuntimeMode) =>
    void saveProjectSandbox(projectId, {
      mode: next,
      connectionId: settings?.connectionId,
      sizeId: settings?.sizeId,
    });

  const description = hasConnection
    ? t('settings.projectDefaultModeSandboxDesc', 'Local, worktree or sandbox for your new threads')
    : t(
        'settings.projectDefaultModeNoSandboxDesc',
        'Local or worktree for your new threads. Choose a sandbox connection below to offer Sandbox.',
      );

  return (
    <ProjectSettingRow
      settingId="project-general.thread-mode"
      title={t('settings.projectDefaultMode', 'Default Thread Mode')}
      description={description}
    >
      <SegmentedControl<ThreadRuntimeMode>
        value={value}
        onChange={onChange}
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
          {
            value: 'sandbox',
            label: t('thread.mode.sandbox', 'Sandbox'),
            icon: <Boxes className="icon-xs" />,
            testId: 'settings-thread-mode-sandbox',
            disabled: !hasConnection,
          },
        ]}
      />
    </ProjectSettingRow>
  );
}

/** Hidden from a viewer: the setting is per-user and only matters to whoever may start threads. */
export function ProjectThreadModeSetting({ projectId }: Props) {
  const canSteer = useCanSteerProject(projectId);
  return canSteer ? <ProjectThreadModeSettingRows projectId={projectId} /> : null;
}
