import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  memo,
  startTransition,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { timeAgo } from '@/lib/thread-utils';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
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

/** Compare only fields that affect the sidebar display of an enriched thread. */
function enrichedThreadVisuallyEqual(a: EnrichedThread, b: EnrichedThread): boolean {
  return (
    threadsVisuallyEqual(a, b) &&
    a.projectName === b.projectName &&
    a.projectPath === b.projectPath &&
    a.projectColor === b.projectColor
  );
}

export function ThreadList({ onArchiveThread, onDeleteThread }: ThreadListProps) {
  const { t: _t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const navigate = useStableNavigate();
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

          // Reuse previous reference if visual fields are identical
          const cached = enrichedCacheRef.current.get(thread.id);
          result.push(cached && enrichedThreadVisuallyEqual(cached, enriched) ? cached : enriched);
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

  // Compute branch keys for visible threads to scope git status selectors.
  const threadBranchKeys = useMemo(
    () => new Map(threads.map((t) => [t.id, computeBranchKey(t)])),
    [threads],
  );

  // Subscribe to a fingerprint string so Zustand skips re-renders when
  // unrelated threads' git statuses change.
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: { statusByBranch: Record<string, GitStatusInfo> }) => {
        let fp = '';
        for (const [id, bk] of threadBranchKeys) {
          const st = s.statusByBranch[bk];
          if (st)
            fp += `${id}:${st.state}:${st.dirtyFileCount}:${st.unpushedCommitCount}:${st.linesAdded}:${st.linesDeleted},`;
        }
        return fp;
      },
      [threadBranchKeys],
    ),
  );

  // Derive the actual status objects only when the fingerprint changes
  const gitStatusByThread = useMemo(() => {
    const { statusByBranch } = useGitStatusStore.getState();
    const result: Record<string, GitStatusInfo> = {};
    for (const [id, bk] of threadBranchKeys) {
      if (statusByBranch[bk]) result[id] = statusByBranch[bk];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadBranchKeys, gitStatusFingerprint]);

  // Eagerly fetch git status for visible threads that don't have it yet.
  // This ensures icons and diff stats show up in the global thread list without requiring a click.
  useEffect(() => {
    const { fetchForThread, statusByBranch: sbb } = useGitStatusStore.getState();
    for (const thread of threads) {
      // Compute branchKey client-side so sibling threads sharing a branch
      // don't trigger redundant fetches when the server mapping is missing.
      const bk = computeBranchKey(thread);
      if (!sbb[bk]) {
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

  const renameThread = useThreadStore((s) => s.renameThread);
  const handleRename = useCallback(
    (thread: EnrichedThread, newTitle: string) => {
      renameThread(thread.id, thread.projectId, newTitle);
    },
    [renameThread],
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

  if (threads.length === 0) {
    return (
      <p data-testid="activity-no-threads" className="px-2 py-2 text-xs text-muted-foreground">
        {_t('sidebar.noThreads')}
      </p>
    );
  }

  return (
    <div className="min-w-0 space-y-0.5">
      {threads.map((thread) => (
        <ThreadListItem
          key={thread.id}
          thread={thread}
          isSelected={selectedThreadId === thread.id}
          isRunning={RUNNING_STATUSES.has(thread.status)}
          gitStatus={gitStatusByThread[thread.id]}
          onSelect={handleSelect}
          onRename={handleRename}
          onArchive={handleArchive}
          onDelete={handleDelete}
        />
      ))}
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
  // Use a ref for the thread so callbacks stay stable even when the
  // thread object reference changes (e.g. cost/sessionId updates).
  const threadRef = useRef(thread) as MutableRefObject<EnrichedThread>;
  threadRef.current = thread;

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
    <ThreadItem
      thread={thread}
      projectPath={thread.projectPath}
      isSelected={isSelected}
      subtitle={thread.projectName}
      projectColor={thread.projectColor}
      timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
      gitStatus={gitStatus}
      onSelect={handleSelect}
      onRename={handleRename}
      onArchive={isRunning ? undefined : handleArchive}
      onDelete={isRunning ? undefined : handleDelete}
    />
  );
});
