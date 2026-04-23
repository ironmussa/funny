import type { Thread, GitStatusInfo } from '@funny/shared';
import { Folder, GitBranch } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DiffStats } from '@/components/DiffStats';
import {
  PowerlineBar,
  type PowerlineBarProps,
  type PowerlineSegmentData,
} from '@/components/ui/powerline-bar';
import { colorFromName, darkenHex } from '@/components/ui/project-chip';
import { cn, resolveThreadBranch } from '@/lib/utils';

export interface ThreadPowerlineProps {
  thread: Thread;
  /** Project display name — segment is omitted when empty/undefined */
  projectName?: string;
  /** Project hex color — falls back to colorFromName(projectName) */
  projectColor?: string;
  /** Tooltip for the project segment (e.g. the full path) */
  projectTooltip?: string;
  /** Git status for DiffStats chip — omit to hide */
  gitStatus?: GitStatusInfo;
  /** DiffStats size variant */
  diffStatsSize?: 'sm' | 'xs' | 'xxs';
  /** Powerline visual style — forwarded to PowerlineBar */
  variant?: PowerlineBarProps['variant'];
  /** Additional className for the outer wrapper */
  className?: string;
  'data-testid'?: string;
}

/**
 * Unified powerline bar for a thread: project → baseBranch → worktree branch + DiffStats.
 *
 * Replaces inline powerline segment construction across Sidebar, KanbanView,
 * LiveColumnsView, AllThreadsView, and ThreadPickerDialog.
 */
export function ThreadPowerline({
  thread,
  projectName,
  projectColor,
  projectTooltip,
  gitStatus,
  diffStatsSize = 'xs',
  variant,
  className,
  ...props
}: ThreadPowerlineProps) {
  const { t } = useTranslation();
  const isWorktree = thread.mode === 'worktree';
  const effectiveBranch = resolveThreadBranch(thread);
  const branchName =
    isWorktree && thread.baseBranch ? thread.baseBranch : effectiveBranch || thread.baseBranch;
  const worktreeBranchLabel = isWorktree ? (effectiveBranch ?? '') : '';
  const worktreePath = thread.worktreePath ?? '';
  const worktreePathShort = worktreePath
    ? worktreePath.split('/').filter(Boolean).pop() || worktreePath
    : '';

  const rawColor = projectColor || (projectName ? colorFromName(projectName) : '#52525b');
  const baseColor = darkenHex(rawColor, 0.1);
  const branchColor = darkenHex(rawColor, 0.2);
  const worktreeColor = darkenHex(rawColor, 0.3);

  const segments = useMemo<PowerlineSegmentData[]>(() => {
    const segs: PowerlineSegmentData[] = [];
    if (projectName) {
      segs.push({
        key: 'project',
        icon: Folder,
        label: projectName,
        color: baseColor,
        tooltip: projectTooltip || projectName,
      });
    }
    if (branchName) {
      const branchTooltip = isWorktree
        ? t('powerline.tooltipBaseBranch', { branch: branchName })
        : t('powerline.tooltipLocalBranch', { branch: branchName });
      segs.push({
        key: 'branch',
        icon: GitBranch,
        label: branchName,
        color: projectName ? branchColor : baseColor,
        tooltip: branchTooltip,
      });
    }
    if (isWorktree && worktreeBranchLabel) {
      const worktreeTooltip = worktreePathShort
        ? t('powerline.tooltipWorktreeWithPath', { path: worktreePathShort })
        : t('powerline.tooltipWorktree');
      segs.push({
        key: 'worktree-branch',
        icon: Folder,
        label: worktreeBranchLabel,
        color: projectName ? worktreeColor : branchColor,
        tooltip: worktreeTooltip,
      });
    }
    return segs;
  }, [
    projectName,
    baseColor,
    projectTooltip,
    branchName,
    branchColor,
    isWorktree,
    worktreeBranchLabel,
    worktreeColor,
    worktreePathShort,
    t,
  ]);

  const hasDiffStats =
    gitStatus &&
    gitStatus.state !== 'clean' &&
    (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0 || gitStatus.dirtyFileCount > 0);

  if (segments.length === 0 && !hasDiffStats) return null;

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {segments.length > 0 && (
        <PowerlineBar
          segments={segments}
          size="sm"
          variant={variant}
          className="min-w-0 flex-shrink"
          data-testid={props['data-testid']}
        />
      )}
      {hasDiffStats && (
        <DiffStats
          linesAdded={gitStatus.linesAdded}
          linesDeleted={gitStatus.linesDeleted}
          dirtyFileCount={gitStatus.dirtyFileCount}
          size={diffStatsSize}
        />
      )}
    </div>
  );
}
