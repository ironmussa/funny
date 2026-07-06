import { memo, useEffect, type ReactNode } from 'react';

import * as variant from '@/lib/thread-variant';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadId, useThreadProjectId, useThreadSelector } from '@/stores/thread-context';

import { MoreActionsMenu } from './header/MoreActionsMenu';
import { ProjectHeaderLeftContent } from './header/ProjectHeaderLeftContent';
import {
  ThreadHeaderActionsBase,
  type ThreadHeaderActionsProps,
} from './header/ThreadHeaderActions';

export const ThreadHeaderActions = memo(function ThreadHeaderActions({
  hideTimeline = false,
  ...props
}: ThreadHeaderActionsProps = {}) {
  return (
    <ThreadHeaderActionsBase
      {...props}
      renderMoreActions={({ isScratchThread, onOpenInEditor }) => (
        <MoreActionsMenu
          onOpenInEditor={!isScratchThread ? onOpenInEditor : undefined}
          hideTimeline={hideTimeline}
        />
      )}
    />
  );
});

interface ProjectHeaderProps {
  hideFiles?: boolean;
  hideTests?: boolean;
  hideStartup?: boolean;
  hideTerminal?: boolean;
  hideTimeline?: boolean;
  /**
   * Suppress the entire thread action cluster (review/files/tests/comments/
   * share/more). Used by the grid column header (`ThreadColumn`), where those
   * actions are consolidated into the grid's view header bound to the selected
   * thread. `trailing` (e.g. the per-cell remove button) is still rendered.
   */
  hideActions?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const ProjectHeader = memo(function ProjectHeader({
  hideFiles = false,
  hideTests = false,
  hideStartup = false,
  hideTerminal = false,
  hideTimeline = false,
  hideActions = false,
  leading,
  trailing,
}: ProjectHeaderProps = {}) {
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadIsScratch = useThreadSelector((t) => variant.isScratch(t));
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const fetchForThread = useGitStatusStore((s) => s.fetchForThread);
  const fetchProjectStatus = useGitStatusStore((s) => s.fetchProjectStatus);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  // Fetch git status when activeThread changes
  useEffect(() => {
    if (activeThreadId) {
      fetchForThread(activeThreadId);
    } else if (selectedProjectId) {
      fetchProjectStatus(selectedProjectId);
    }
  }, [activeThreadId, selectedProjectId, fetchForThread, fetchProjectStatus]);

  if (!projectId && !activeThreadIsScratch) return null;

  return (
    <div className="border-border flex h-12 items-center border-b px-4 py-2">
      <div className="flex w-full items-center justify-between">
        <ProjectHeaderLeftContent leading={leading} />
        {hideActions ? (
          trailing ? (
            <div className="flex shrink-0 items-center gap-2">{trailing}</div>
          ) : null
        ) : (
          <ThreadHeaderActions
            hideFiles={hideFiles}
            hideTests={hideTests}
            hideStartup={hideStartup}
            hideTerminal={hideTerminal}
            hideTimeline={hideTimeline}
            trailing={trailing}
          />
        )}
      </div>
    </div>
  );
});
