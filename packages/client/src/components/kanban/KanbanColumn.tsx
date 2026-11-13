import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Project, Thread, ThreadStage } from '@funny/shared';
import { type ComponentProps, type ComponentType, memo, useEffect, useRef, useState } from 'react';

import { KanbanColumnSurface } from '@/components/kanban/KanbanColumnHeader';
import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';

import { KanbanCard } from './KanbanCard';

interface Props {
  stage: ThreadStage;
  threads: Thread[];
  projectInfoById?: Record<string, { name: string; color?: string; path?: string }>;
  onDelete: (thread: Thread) => void;
  onArchive: (thread: Thread) => void;
  projectId?: string;
  projects: Project[];
  onAddThread: (projectId: string, stage: ThreadStage) => void;
  search?: string;
  caseSensitive?: boolean;
  cardComponent?: ComponentType<ComponentProps<typeof KanbanCard> & { caseSensitive?: boolean }>;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
  statusByThread: Record<string, GitStatusInfo>;
}

export const KanbanColumn = memo(function KanbanColumn({
  stage,
  threads,
  projectInfoById,
  onDelete,
  onArchive,
  projectId,
  projects,
  onAddThread,
  search,
  caseSensitive,
  cardComponent: Card = KanbanCard,
  contentSnippets,
  highlightThreadId,
  statusByThread,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isDraggedOver, setIsDraggedOver] = useState(false);
  const paginationKey = `${projectId}:${search}`;
  const [pagination, setPagination] = useState({ key: paginationKey, visibleCount: 20 });
  const storedVisibleCount = pagination.key === paginationKey ? pagination.visibleCount : 20;
  const highlightedIndex = highlightThreadId
    ? threads.findIndex((thread) => thread.id === highlightThreadId)
    : -1;
  const visibleCount = Math.max(storedVisibleCount, highlightedIndex + 1);
  if (pagination.key !== paginationKey || pagination.visibleCount !== visibleCount) {
    setPagination({ key: paginationKey, visibleCount });
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'kanban-column', stage }),
      canDrop: ({ source }) => source.data.type === 'kanban-card',
      onDragEnter: () => setIsDraggedOver(true),
      onDragLeave: () => setIsDraggedOver(false),
      onDrop: () => setIsDraggedOver(false),
    });
  }, [stage]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  const visibleThreads = threads.slice(0, visibleCount);
  const hasMore = threads.length > visibleCount;

  return (
    <KanbanColumnSurface
      columnRef={ref}
      scrollRef={scrollRef}
      isDraggedOver={isDraggedOver}
      stage={stage}
      count={threads.length}
      projectId={projectId}
      projects={projects}
      onAddThread={onAddThread}
    >
      <>
        {visibleThreads.map((thread) => (
          <Card
            key={thread.id}
            thread={thread}
            projectInfo={projectInfoById?.[thread.projectId]}
            onDelete={onDelete}
            onArchive={stage !== 'archived' ? onArchive : undefined}
            search={search}
            caseSensitive={caseSensitive}
            ghost={stage === 'archived'}
            contentSnippet={contentSnippets?.get(thread.id)}
            projectId={projectId}
            highlighted={thread.id === highlightThreadId}
            stage={stage}
            gitStatus={statusByThread[thread.id]}
          />
        ))}
        <LoadMoreSentinel
          hasMore={hasMore}
          itemCount={visibleThreads.length}
          onLoadMore={() =>
            setPagination((prev) => ({
              key: paginationKey,
              visibleCount: (prev.key === paginationKey ? prev.visibleCount : 20) + 20,
            }))
          }
          testId={`kanban-load-more-${stage}`}
          className="py-0"
        />
      </>
    </KanbanColumnSurface>
  );
});
