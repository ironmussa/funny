import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import { useEffect, useMemo, useCallback, useRef, memo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

const RUNNING_STATUSES = new Set<ThreadStatus>(['running', 'waiting', 'pending']);
const FINISHED_STATUSES = new Set<ThreadStatus>(['completed', 'failed', 'stopped', 'interrupted']);
const VISIBLE_STATUSES = new Set<ThreadStatus>([...RUNNING_STATUSES, ...FINISHED_STATUSES]);

interface EnrichedThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

interface ThreadListProps {
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

/** Shallow-compare two objects (same keys, same values by ===). */
function shallowEqual(a: object, b: object): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if ((a as never)[key] !== (b as never)[key]) return false;
  }
  return true;
}

export function ThreadList({ onArchiveThread, onDeleteThread }: ThreadListProps) {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const navigate = useNavigate();
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useProjectStore((s) => s.projects);

  // Cache enriched threads to maintain stable references across renders.
  // Without this, every useMemo run creates new objects via spread even
  // when the underlying thread data hasn't changed, defeating memo().
  const enrichedCacheRef = useRef<Map<string, EnrichedThread>>(new Map());

  const { threads, totalCount } = useMemo(() => {
    const result: EnrichedThread[] = [];
    const projectMap = new Map(
      projects.map((p) => [p.id, { name: p.name, path: p.path, color: p.color }]),
    );

    for (const [projectId, projectThreads] of Object.entries(threadsByProject)) {
      for (const thread of projectThreads) {
        if (VISIBLE_STATUSES.has(thread.status) && !thread.archived) {
          const project = projectMap.get(projectId);
          const enriched: EnrichedThread = {
            ...thread,
            projectName: project?.name ?? projectId,
            projectPath: project?.path ?? '',
            projectColor: project?.color,
          };

          // Reuse previous reference if data is identical
          const cached = enrichedCacheRef.current.get(thread.id);
          result.push(cached && shallowEqual(cached, enriched) ? cached : enriched);
        }
      }
    }

    // Sort: running/waiting first, then by date descending
    result.sort((a, b) => {
      const aRunning = RUNNING_STATUSES.has(a.status) ? 1 : 0;
      const bRunning = RUNNING_STATUSES.has(b.status) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      const dateA = a.completedAt ?? a.createdAt;
      const dateB = b.completedAt ?? b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    // Always show at most 5 threads total, prioritizing running ones
    const visible = result.slice(0, 5);

    // Update cache with current visible threads
    const nextCache = new Map<string, EnrichedThread>();
    for (const th of visible) {
      nextCache.set(th.id, th);
    }
    enrichedCacheRef.current = nextCache;

    return { threads: visible, totalCount: result.length };
  }, [threadsByProject, projects]);

  // Read the full statusByThread and pick only visible entries via useMemo.
  // Individual GitStatusInfo references are stable (only change when that
  // thread's status actually updates), so ThreadItem memo is not defeated.
  const statusByThread = useGitStatusStore((s) => s.statusByThread);
  const gitStatusByThread = useMemo(() => {
    const result: Record<string, GitStatusInfo> = {};
    for (const t of threads) {
      if (statusByThread[t.id]) {
        result[t.id] = statusByThread[t.id];
      }
    }
    return result;
  }, [threads, statusByThread]);

  // Eagerly fetch git status for visible threads that don't have it yet.
  // This ensures icons and diff stats show up in the global thread list without requiring a click.
  useEffect(() => {
    const { fetchForThread, statusByThread } = useGitStatusStore.getState();
    for (const thread of threads) {
      if (!statusByThread[thread.id]) {
        fetchForThread(thread.id);
      }
    }
  }, [threads]);

  // Stable callbacks that avoid creating new closures per thread inside .map().
  // ThreadItem is memo'd, so stable references prevent unnecessary re-renders.
  const handleSelect = useCallback(
    (threadId: string, projectId: string) => {
      startTransition(() => {
        const store = useThreadStore.getState();
        if (
          store.selectedThreadId === threadId &&
          (!store.activeThread || store.activeThread.id !== threadId)
        ) {
          store.selectThread(threadId);
        }
        navigate(`/projects/${projectId}/threads/${threadId}`);
      });
    },
    [navigate],
  );

  const handleArchive = useCallback(
    (thread: EnrichedThread) => {
      onArchiveThread(
        thread.id,
        thread.projectId,
        thread.title,
        thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external',
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
        thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external',
      );
    },
    [onDeleteThread],
  );

  if (threads.length === 0) return null;

  return (
    <div className="min-w-0 space-y-0.5">
      {threads.map((thread) => {
        const isRunning = RUNNING_STATUSES.has(thread.status);
        return (
          <ThreadListItem
            key={thread.id}
            thread={thread}
            isSelected={selectedThreadId === thread.id}
            isRunning={isRunning}
            gitStatus={gitStatusByThread[thread.id]}
            onSelect={handleSelect}
            onArchive={thread.status === 'running' ? undefined : handleArchive}
            onDelete={thread.status === 'running' ? undefined : handleDelete}
            t={t}
          />
        );
      })}
      {totalCount > 5 && (
        <ViewAllButton
          onClick={() => navigate('/list?status=completed,failed,stopped,interrupted')}
        />
      )}
    </div>
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
  onArchive,
  onDelete,
  t,
}: {
  thread: EnrichedThread;
  isSelected: boolean;
  isRunning: boolean;
  gitStatus?: GitStatusInfo;
  onSelect: (threadId: string, projectId: string) => void;
  onArchive?: (thread: EnrichedThread) => void;
  onDelete?: (thread: EnrichedThread) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handleSelect = useCallback(
    () => onSelect(thread.id, thread.projectId),
    [onSelect, thread.id, thread.projectId],
  );
  const handleArchive = useMemo(
    () => (onArchive ? () => onArchive(thread) : undefined),
    [onArchive, thread],
  );
  const handleDelete = useMemo(
    () => (onDelete ? () => onDelete(thread) : undefined),
    [onDelete, thread],
  );

  return (
    <ThreadItem
      thread={thread}
      projectPath={thread.projectPath}
      isSelected={isSelected}
      subtitle={thread.projectName}
      projectColor={thread.projectColor}
      timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
      gitStatus={gitStatus}
      onSelect={handleSelect}
      onArchive={handleArchive}
      onDelete={handleDelete}
    />
  );
});
