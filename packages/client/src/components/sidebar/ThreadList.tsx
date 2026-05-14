import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  memo,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { cn } from '@/lib/utils';
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
  onRenameThread: (threadId: string, projectId: string, title: string) => void;
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

export function ThreadList({ onRenameThread, onArchiveThread, onDeleteThread }: ThreadListProps) {
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
        if (VISIBLE_STATUSES.has(thread.status) && !thread.archived && thread.stage !== 'done') {
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

    // Running threads always go first, then sort each group by most recent
    // activity. Without the status priority, a long-running thread with an
    // old createdAt gets pushed below recently-finished threads and drops
    // out of the top 5.
    result.sort((a, b) => {
      const aRunning = a.status === 'running';
      const bRunning = b.status === 'running';
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
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
            fp += `${id}:${st.state}:${st.dirtyFileCount}:${st.unpushedCommitCount}:${st.unpulledCommitCount}:${st.linesAdded}:${st.linesDeleted},`;
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
  // Uses ensureStatusForThreads to deduplicate by branchKey across all callers.
  useEffect(() => {
    useGitStatusStore.getState().ensureStatusForThreads(threads);
  }, [threads]);

  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();

  // Keep a ref to threads so the async handleSelect always reads the latest list.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  // Stable callbacks that avoid creating new closures per thread inside .map().
  // ThreadItem is memo'd, so stable references prevent unnecessary re-renders.
  const handleSelect = useCallback(
    async (threadId: string, projectId: string) => {
      // Check if the thread requires a branch switch (local mode only)
      const thread = threadsRef.current.find((th) => th.id === threadId);
      if (thread?.mode === 'local') {
        const branch = resolveThreadBranch(thread);
        if (branch) {
          // Kick off thread data fetch in parallel with the branch preflight so
          // the network roundtrips overlap instead of serializing. If the user
          // cancels the branch dialog we just discard the prefetched data.
          useThreadStore.getState().prefetchThread(threadId);
          const canProceed = await ensureBranch(projectId, branch);
          if (!canProceed) return;
        }
      }

      // Ensure the project is expanded so the thread row is mounted in the
      // projects list before we try to scroll to it.
      const projectStore = useProjectStore.getState();
      if (!projectStore.expandedProjects.has(projectId)) {
        projectStore.toggleProject(projectId);
      }

      // Run state changes at full priority so the center pane updates in
      // parallel with the sidebar's smooth scroll. Wrapping these in
      // startTransition deferred the commit, making the swap appear to
      // happen *after* the scroll animation finished.
      const store = useThreadStore.getState();
      if (
        store.selectedThreadId === threadId &&
        (!store.activeThread || store.activeThread.id !== threadId)
      ) {
        store.selectThread(threadId);
      }
      navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
    },
    [navigate, ensureBranch],
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
      <p data-testid="activity-no-threads" className="px-2 py-2 text-xs text-muted-foreground">
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
          <ViewAllButton onClick={() => navigate(buildPath('/list?sort=updated'))} />
        )}
      </div>
      {branchSwitchDialog}
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
  // Use a ref for the thread so callbacks stay stable even when the
  // thread object reference changes (e.g. cost/sessionId updates).
  const threadRef = useRef(thread) as MutableRefObject<EnrichedThread>;
  threadRef.current = thread;

  // Drag support: allow dragging threads into grid cells
  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'grid-thread',
        threadId: thread.id,
        projectId: thread.projectId,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) =>
        setDashedDragPreview({ nativeSetDragImage, source: el }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, thread.projectId]);

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
        timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
        gitStatus={gitStatus}
        href={buildPath(`/projects/${thread.projectId}/threads/${thread.id}`)}
        onSelect={handleSelect}
        onRename={handleRename}
        onArchive={isRunning ? undefined : handleArchive}
        onDelete={handleDelete}
      />
    </div>
  );
});
