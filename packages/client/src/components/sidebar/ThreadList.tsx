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

import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { useScratchThreads, useThreadsByProject } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';
import { isScratch } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import {
  resolveLocalThreadBranch,
  resolveThreadBranch,
  shouldCheckoutBranchForThreadSelect,
} from '@/lib/utils';
import { cn } from '@/lib/utils';
import { goToThread } from '@/navigation/go-to-thread';
import { buildThreadPath } from '@/navigation/thread-paths';
import {
  useGitStatusStore,
  branchKey as computeBranchKey,
  gitStatusForThreadFromState,
  gitStatusSidebarFingerprint,
} from '@/stores/git-status-store';
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
  const threadsByProject = useThreadsByProject();
  const scratchThreads = useScratchThreads();
  // Highlight follows the URL (route-driven), not the async selectedThreadId.
  const activeThreadId = useActiveThreadId();
  const projects = useProjectStore((s) => s.projects);

  // Cache enriched threads to maintain stable references across renders.
  // Without this, every useMemo run creates new objects via spread even
  // when the underlying thread data hasn't changed, defeating memo().
  const enrichedCacheRef = useRef<Map<string, EnrichedThread>>(new Map());

  const { threads, totalCount } = useMemo(() => {
    const result: EnrichedThread[] = [];
    const seenThreadIds = new Set<string>();
    const projectMap = new Map(
      projects.map((p) => [p.id, { name: p.name, path: p.path, color: p.color }]),
    );

    const includeThread = (
      thread: Thread,
      projectName: string,
      projectPath: string,
      projectColor?: string,
    ) => {
      if (seenThreadIds.has(thread.id)) return;
      if (!VISIBLE_STATUSES.has(thread.status) || thread.archived || thread.stage === 'done')
        return;
      seenThreadIds.add(thread.id);
      const enriched: EnrichedThread = {
        ...thread,
        projectName,
        projectPath,
        projectColor,
      };
      // Reuse previous reference if visual fields are identical
      const cached = enrichedCacheRef.current.get(thread.id);
      result.push(cached && enrichedThreadVisuallyEqual(cached, enriched) ? cached : enriched);
    };

    for (const [projectId, projectThreads] of Object.entries(threadsByProject)) {
      const project = projectMap.get(projectId);
      for (const thread of projectThreads) {
        includeThread(thread, project?.name ?? projectId, project?.path ?? '', project?.color);
      }
    }

    for (const thread of scratchThreads) {
      includeThread(thread, _t('sidebar.scratchTitle', { defaultValue: 'Quick Chats' }), '');
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
  }, [threadsByProject, scratchThreads, projects, _t]);

  // Compute branch keys for visible threads to scope git status selectors.
  const threadBranchKeys = useMemo(
    () => new Map(threads.map((t) => [t.id, computeBranchKey(t)])),
    [threads],
  );

  // Subscribe to a fingerprint string so Zustand skips re-renders when
  // unrelated threads' git statuses change.
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: {
        statusByBranch: Record<string, GitStatusInfo>;
        threadToBranchKey: Record<string, string>;
      }) => {
        let fp = '';
        for (const [id, fallbackBk] of threadBranchKeys) {
          const bk = s.threadToBranchKey[id] ?? fallbackBk;
          const st = s.statusByBranch[bk];
          if (st) fp += `${gitStatusSidebarFingerprint(id, st)},`;
        }
        return fp;
      },
      [threadBranchKeys],
    ),
  );

  // Derive the actual status objects only when the fingerprint changes
  const gitStatusByThread = useMemo(() => {
    const state = useGitStatusStore.getState();
    const result: Record<string, GitStatusInfo> = {};
    for (const thread of threads) {
      const status = gitStatusForThreadFromState(state, thread);
      if (status) result[thread.id] = status;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  }, [threads, threadBranchKeys, gitStatusFingerprint]);

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
      const thread = threadsRef.current.find((th) => th.id === threadId);
      const scratch = isScratch(thread);

      // Check if the thread requires a branch switch (local mode only).
      // Scratch threads have no git working tree — never run the branch preflight.
      const storeBeforeNav = useThreadStore.getState();
      const activeThread =
        storeBeforeNav.activeThread ??
        (storeBeforeNav.selectedThreadId
          ? storeBeforeNav.threadsById[storeBeforeNav.selectedThreadId]
          : undefined);
      if (!scratch && thread && shouldCheckoutBranchForThreadSelect(thread, activeThread)) {
        const branch = resolveLocalThreadBranch(thread)!;
        // Kick off thread data fetch in parallel with the branch preflight so
        // the network roundtrips overlap instead of serializing. If the user
        // cancels the branch dialog we just discard the prefetched data.
        useThreadStore.getState().prefetchThread(threadId);
        const canProceed = await ensureBranch(projectId, branch);
        if (!canProceed) return;
      }

      // Expand/select project, kick hydration, and navigate — all via the one
      // facade. Falls back to a non-scratch target when the row isn't in the
      // current list (e.g. cross-project deep action).
      goToThread(navigate, thread ?? { id: threadId, projectId, isScratch: false });
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
        href={buildThreadPath(thread)}
        onSelect={handleSelect}
        onRename={handleRename}
        onArchive={isRunning ? undefined : handleArchive}
        onDelete={handleDelete}
      />
    </div>
  );
});
