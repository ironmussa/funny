/**
 * Where the current user's new threads start on a project: the project
 * directory, a worktree, or their sandbox for the project (change
 * project-runtime-settings). The choice is per user and per project, stored in
 * their runtime row; absent means `local`. Every member may pick local or
 * worktree. Sandbox is offered to the project owner only (until members get
 * their own sandbox) and needs a sandbox connection chosen first.
 */
import { Boxes, GitBranch, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { saveProjectSandbox } from '@/data/runner/actions';
import { useProjectSandbox } from '@/data/runner/hooks';
import { useAuthStore } from '@/stores/auth-store';

import { SegmentedControl, SettingRow } from './setting-primitives';

type ThreadRuntimeMode = 'local' | 'worktree' | 'sandbox';

interface Props {
  projectId: string;
  ownerId: string;
}

export function ProjectThreadModeSetting({ projectId, ownerId }: Props) {
  const { t } = useTranslation();
  const isOwner = useAuthStore((s) => s.user?.id === ownerId);
  const { sandbox } = useProjectSandbox(projectId);
  const settings = sandbox?.settings ?? null;

  // Sandbox is owner-only for now and needs a connection on the runtime row.
  const offersSandbox = isOwner;
  const hasConnection = !!settings?.connectionId;
  const stored = settings?.mode ?? 'local';
  // Never select an option that is not offered (a member with a stale sandbox row).
  const value: ThreadRuntimeMode = stored === 'sandbox' && !offersSandbox ? 'local' : stored;

  const onChange = (next: ThreadRuntimeMode) =>
    void saveProjectSandbox(projectId, {
      mode: next,
      connectionId: settings?.connectionId,
      sizeId: settings?.sizeId,
    });

  const description = !offersSandbox
    ? t('settings.projectDefaultModeDesc', 'Local or worktree for your new threads')
    : hasConnection
      ? t(
          'settings.projectDefaultModeSandboxDesc',
          'Local, worktree or sandbox for your new threads',
        )
      : t(
          'settings.projectDefaultModeNoSandboxDesc',
          'Local or worktree for your new threads. Choose a sandbox connection below to offer Sandbox.',
        );

  return (
    <SettingRow
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
          ...(offersSandbox
            ? [
                {
                  value: 'sandbox' as const,
                  label: t('thread.mode.sandbox', 'Sandbox'),
                  icon: <Boxes className="icon-xs" />,
                  testId: 'settings-thread-mode-sandbox',
                  disabled: !hasConnection,
                },
              ]
            : []),
        ]}
      />
    </SettingRow>
  );
}
