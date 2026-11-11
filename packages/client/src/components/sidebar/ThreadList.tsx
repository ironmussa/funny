import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import { useMemo, useCallback, useRef, useLayoutEffect, memo, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjects } from '@/data/projects/hooks';
import { useLoadedThreads } from '@/data/threads/hooks';
import { selectActivityThreads } from '@/data/threads/views';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useVisibleGitStatus } from '@/hooks/use-git-status-scope';
import { useGridThreadDrag } from '@/hooks/use-grid-thread-drag';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useSidebarGitStatuses } from '@/hooks/use-sidebar-git-statuses';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { goToThread } from '@/navigation/go-to-thread';
import { buildThreadPath } from '@/navigation/thread-paths';

import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

const RUNNING_STATUSES = new Set<ThreadStatus>(['running', 'waiting', 'pending']);

interface EnrichedThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

interface ThreadListProps {
  onRenameThread: (threadId: string, projectId: string, title: string) => void;
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function ThreadList({ onRenameThread, onArchiveThread, onDeleteThread }: ThreadListProps) {
  const { t: _t } = useTranslation();
  const navigate = useStableNavigate();
  // Every loaded project list plus scratch, from a live query on the threads collection.
  const loadedThreads = useLoadedThreads(null);
  // Highlight follows the URL (route-driven), not the async selectedThreadId.
  const activeThreadId = useActiveThreadId();
  const projects = useProjects();

  const { threads, totalCount } = useMemo(() => {
    const projectMap = new Map(
      projects.map((p) => [p.id, { name: p.name, path: p.path, color: p.color }]),
    );
    const activity = selectActivityThreads(loadedThreads);
    const enriched: EnrichedThread[] = activity.threads.map((thread) => {
      if (thread.isScratch) {
        return {
          ...thread,
          projectName: _t('sidebar.scratchTitle', { defaultValue: 'Quick Chats' }),
          projectPath: '',
        };
      }
      const project = projectMap.get(thread.projectId);
      return {
        ...thread,
        projectName: project?.name ?? thread.projectId,
        projectPath: project?.path ?? '',
        projectColor: project?.color,
      };
    });
    return { threads: enriched, totalCount: activity.totalCount };
  }, [loadedThreads, projects, _t]);

  const gitStatusByThread = useSidebarGitStatuses(threads);

  useVisibleGitStatus(threads);

  // Keep a ref to threads so handleSelect always reads the latest list.
  const threadsRef = useRef(threads);
  useLayoutEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Stable callbacks that avoid creating new closures per thread inside .map().
  // ThreadItem is memo'd, so stable references prevent unnecessary re-renders.
  const handleSelect = useCallback(
    async (threadId: string, projectId: string) => {
      const thread = threadsRef.current.find((th) => th.id === threadId);
      // Expand/select project, kick hydration, and navigate — all via the one
      // facade. Falls back to a non-scratch target when the row isn't in the
      // current list (e.g. cross-project deep action).
      goToThread(navigate, thread ?? { id: threadId, projectId, isScratch: false });
    },
    [navigate],
  );

  const handleRename = useCallback(
    (thread: EnrichedThread, newTitle: string) => {
      onRenameThread(thread.id, thread.projectId, newTitle);
    },
    [onRenameThread],
  );

  const handleArchive = useCallback(
    (thread: EnrichedThread) => {
      onArchiveThread(
        thread.id,
        thread.projectId,
        thread.title,
        thread.mode === 'worktree' &&
          !!resolveThreadBranch(thread) &&
          thread.provider !== 'external',
      );
    },
    [onArchiveThread],
  );

  const handleDelete = useCallback(
    (thread: EnrichedThread) => {
      onDeleteThread(
        thread.id,
        thread.projectId,
        thread.title,
        thread.mode === 'worktree' &&
          !!resolveThreadBranch(thread) &&
          thread.provider !== 'external',
      );
    },
    [onDeleteThread],
  );

  if (threads.length === 0) {
    return (
      <p data-testid="activity-no-threads" className="text-muted-foreground px-2 py-2 text-xs">
        {_t('sidebar.noThreads')}
      </p>
    );
  }

  return (
    <>
      <div className="min-w-0 space-y-0.5">
        {threads.map((thread) => (
          <ThreadListItem
            key={thread.id}
            thread={thread}
            isSelected={activeThreadId === thread.id}
            isRunning={RUNNING_STATUSES.has(thread.status)}
            gitStatus={gitStatusByThread[thread.id]}
            onSelect={handleSelect}
            onRename={handleRename}
            onArchive={handleArchive}
            onDelete={handleDelete}
          />
        ))}
        {totalCount > 5 && (
          <ViewAllButton onClick={() => navigate(buildPath('/list?sort=updated'))} />
        )}
      </div>
    </>
  );
}

// Wrapper that converts stable (threadId, projectId) callbacks into the
// parameterless callbacks that ThreadItem expects, memoized per thread.
const ThreadListItem = memo(function ThreadListItem({
  thread,
  isSelected,
  isRunning,
  gitStatus,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: {
  thread: EnrichedThread;
  isSelected: boolean;
  isRunning: boolean;
  gitStatus?: GitStatusInfo;
  onSelect: (threadId: string, projectId: string) => void;
  onRename: (thread: EnrichedThread, newTitle: string) => void;
  onArchive: (thread: EnrichedThread) => void;
  onDelete: (thread: EnrichedThread) => void;
}) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  // Use a ref for the thread so callbacks stay stable even when the
  // thread object reference changes (e.g. cost/sessionId updates).
  const threadRef = useRef(thread) as MutableRefObject<EnrichedThread>;
  useLayoutEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  // Drag support: allow dragging threads into grid cells
  const { dragRef, isDragging } = useGridThreadDrag(thread.id, thread.projectId);

  const handleSelect = useCallback(
    () => onSelect(thread.id, thread.projectId),
    [onSelect, thread.id, thread.projectId],
  );
  const handleRename = useCallback(
    (newTitle: string) => onRename(threadRef.current, newTitle),
    [onRename, threadRef],
  );
  const handleArchive = useCallback(() => onArchive(threadRef.current), [onArchive, threadRef]);
  const handleDelete = useCallback(() => onDelete(threadRef.current), [onDelete, threadRef]);

  return (
    <div ref={dragRef} className={cn(isDragging && 'opacity-50')}>
      <ThreadItem
        thread={thread}
        projectPath={thread.projectPath}
        isSelected={isSelected}
        subtitle={thread.projectName}
        projectColor={thread.projectColor}
        timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t, now)}
        gitStatus={gitStatus}
        href={buildThreadPath(thread)}
        onSelect={handleSelect}
        onRename={handleRename}
        onArchive={isRunning ? undefined : handleArchive}
        onDelete={handleDelete}
      />
    </div>
  );
});
