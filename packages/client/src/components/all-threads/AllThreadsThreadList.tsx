import type { GitStatusInfo, Thread } from '@funny/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { SidebarDialogs } from '@/components/sidebar/SidebarDialogs';
import { ThreadItem } from '@/components/sidebar/ThreadItem';
import { normalize } from '@/components/ui/highlight-text';
import { LoadingState } from '@/components/ui/loading-state';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { timeAgo } from '@/lib/thread-utils';
import { isScratch } from '@/lib/thread-variant';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { buildThreadPath } from '@/navigation/thread-paths';
import { branchKey as computeBranchKey, useGitStatusStore } from '@/stores/git-status-store';
import { useUIStore } from '@/stores/ui-store';

const ROW_ESTIMATE_PX = 64;
const LOAD_MORE_THRESHOLD = 5;

interface ProjectInfo {
  name: string;
  path: string;
  color?: string;
}

interface Props {
  threads: Thread[];
  search: string;
  caseSensitive: boolean;
  contentSnippets: Map<string, string>;
  emptyMessage: string;
  searchEmptyMessage: string;
  projectFilter: string | null;
  projectInfoById: Record<string, ProjectInfo>;
  hasMore: boolean;
  loadingMore: boolean;
  onEndReached: () => void;
  onSearchKeyDownRef: MutableRefObject<((e: KeyboardEvent) => void) | null>;
  className?: string;
}

export function AllThreadsThreadList({
  threads,
  search,
  caseSensitive,
  contentSnippets,
  emptyMessage,
  searchEmptyMessage,
  projectFilter,
  projectInfoById,
  hasMore,
  loadingMore,
  onEndReached,
  onSearchKeyDownRef,
  className,
}: Props) {
  const { t } = useTranslation();
  const activeThreadId = useActiveThreadId();
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const actions = useSidebarActions();
  const {
    handleSelectThread,
    handleArchiveThreadFromList,
    handleRenameThread,
    handlePinThread,
    handleDeleteThreadFromList,
  } = actions;

  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => threads[index]?.id ?? index,
    overscan: 10,
  });

  useEffect(() => {
    setHighlightIndex(-1);
  }, [search, threads]);

  const handleThreadSelect = useCallback(
    async (thread: Thread) => {
      useUIStore.getState().setKanbanContext({
        projectId: projectFilter || undefined,
        search,
        caseSensitive,
        threadId: thread.id,
        viewMode: 'list',
      });

      await handleSelectThread(thread.projectId, thread.id);

      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-project-id="${thread.projectId}"] [data-testid="thread-item-${thread.id}"]`,
        );
        el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      });
    },
    [caseSensitive, handleSelectThread, projectFilter, search],
  );

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (threads.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = highlightIndex < threads.length - 1 ? highlightIndex + 1 : 0;
        setHighlightIndex(next);
        virtualizer.scrollToIndex(next, { align: 'auto' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = highlightIndex > 0 ? highlightIndex - 1 : threads.length - 1;
        setHighlightIndex(prev);
        virtualizer.scrollToIndex(prev, { align: 'auto' });
      } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < threads.length) {
        e.preventDefault();
        void handleThreadSelect(threads[highlightIndex]);
      }
    },
    [handleThreadSelect, highlightIndex, threads, virtualizer],
  );

  useEffect(() => {
    onSearchKeyDownRef.current = handleSearchKeyDown;
    return () => {
      onSearchKeyDownRef.current = null;
    };
  }, [onSearchKeyDownRef, handleSearchKeyDown]);

  const virtualItems = virtualizer.getVirtualItems();

  const visibleThreads = useMemo(
    () => virtualItems.map((v) => threads[v.index]).filter((thread): thread is Thread => !!thread),
    [threads, virtualItems],
  );

  useEffect(() => {
    useGitStatusStore.getState().ensureStatusForThreads(visibleThreads);
  }, [visibleThreads]);

  useEffect(() => {
    if (!hasMore || loadingMore) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= threads.length - 1 - LOAD_MORE_THRESHOLD) {
      onEndReached();
    }
  }, [virtualItems, hasMore, loadingMore, onEndReached, threads.length]);

  if (threads.length === 0) {
    return (
      <div
        className={cn(
          'flex h-32 items-center justify-center text-xs text-muted-foreground',
          className,
        )}
      >
        {search ? searchEmptyMessage : emptyMessage}
      </div>
    );
  }

  return (
    <>
      <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
        <div
          ref={scrollRef}
          data-testid="all-threads-thread-list-scroll"
          className="border-border/50 min-h-0 flex-1 overflow-y-auto rounded-lg border p-2"
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((v) => {
              const thread = threads[v.index];
              if (!thread) return null;
              const projectInfo = projectInfoById[thread.projectId];
              const gitStatus: GitStatusInfo | undefined = statusByBranch[computeBranchKey(thread)];
              const branch = resolveThreadBranch(thread);
              const isWorktree =
                thread.mode === 'worktree' && !!branch && thread.provider !== 'external';
              const isRunning = thread.status === 'running';
              const titleMatches = search
                ? caseSensitive
                  ? thread.title.includes(search)
                  : normalize(thread.title).includes(normalize(search))
                : false;
              const contentSnippet =
                search && !titleMatches ? contentSnippets.get(thread.id) : undefined;

              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  data-testid={`all-threads-thread-item-${thread.id}`}
                  ref={virtualizer.measureElement}
                  onMouseMove={() => setHighlightIndex(v.index)}
                  className="absolute top-0 left-0 w-full px-0.5 pb-1"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <ThreadItem
                    thread={thread}
                    projectPath={projectInfo?.path ?? ''}
                    isSelected={activeThreadId === thread.id || highlightIndex === v.index}
                    subtitle={
                      isScratch(thread)
                        ? undefined
                        : (projectInfo?.name ??
                          t('allThreads.unknownProject', { defaultValue: 'Unknown project' }))
                    }
                    projectColor={projectInfo?.color}
                    timeValue={timeAgo(thread.completedAt ?? thread.createdAt, t)}
                    search={search || undefined}
                    contentSnippet={contentSnippet}
                    metadataBadge={
                      thread.archived ? (
                        <span className="bg-muted text-status-warning/80 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] leading-tight font-medium">
                          <Archive className="icon-2xs" />
                          {t('allThreads.archived')}
                        </span>
                      ) : undefined
                    }
                    gitStatus={gitStatus}
                    href={buildThreadPath(thread)}
                    onSelect={() => void handleThreadSelect(thread)}
                    onRename={(newTitle) =>
                      handleRenameThread(thread.projectId, thread.id, newTitle)
                    }
                    onPin={() => handlePinThread(thread.projectId, thread.id, !thread.pinned)}
                    onArchive={
                      isRunning || thread.archived
                        ? undefined
                        : () =>
                            handleArchiveThreadFromList(
                              thread.id,
                              thread.projectId,
                              thread.title,
                              isWorktree,
                            )
                    }
                    onDelete={() =>
                      handleDeleteThreadFromList(
                        thread.id,
                        thread.projectId,
                        thread.title,
                        isWorktree,
                      )
                    }
                  />
                </div>
              );
            })}
          </div>
          {loadingMore && (
            <LoadingState
              fill={false}
              layout="inline"
              size="compact"
              className="py-3"
              testId="all-threads-thread-list-loading-more"
              label={t('common.loading')}
            />
          )}
        </div>
      </div>

      <AllThreadsActionDialogs actions={actions} />
    </>
  );
}

function AllThreadsActionDialogs({ actions }: { actions: ReturnType<typeof useSidebarActions> }) {
  return (
    <>
      <SidebarDialogs
        archiveConfirm={actions.archiveConfirm}
        setArchiveConfirm={actions.setArchiveConfirm}
        handleArchiveConfirm={actions.handleArchiveConfirm}
        deleteThreadConfirm={actions.deleteThreadConfirm}
        setDeleteThreadConfirm={actions.setDeleteThreadConfirm}
        handleDeleteThreadConfirm={actions.handleDeleteThreadConfirm}
        renameProjectState={actions.renameProjectState}
        setRenameProjectState={actions.setRenameProjectState}
        handleRenameProjectConfirm={actions.handleRenameProjectConfirm}
        deleteProjectConfirm={actions.deleteProjectConfirm}
        setDeleteProjectConfirm={actions.setDeleteProjectConfirm}
        handleDeleteProjectConfirm={actions.handleDeleteProjectConfirm}
        issuesProjectId={actions.issuesProjectId}
        setIssuesProjectId={actions.setIssuesProjectId}
        actionLoading={actions.actionLoading}
      />
      {actions.branchSwitchDialog}
    </>
  );
}
