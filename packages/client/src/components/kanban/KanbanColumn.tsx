import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Project, Thread, ThreadStage } from '@funny/shared';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { stageConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { AddThreadButton } from './AddThreadButton';
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
  contentSnippets,
  highlightThreadId,
  statusByThread,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isDraggedOver, setIsDraggedOver] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);

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

  useEffect(() => {
    setVisibleCount(20);
  }, [search, projectId]);

  useEffect(() => {
    if (!highlightThreadId) return;
    const idx = threads.findIndex((th) => th.id === highlightThreadId);
    if (idx >= visibleCount) {
      setVisibleCount(idx + 1);
    }
  }, [highlightThreadId, threads, visibleCount]);

  const visibleThreads = threads.slice(0, visibleCount);
  const hasMore = threads.length > visibleCount;

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col w-92 min-w-92 shrink-0 rounded-lg bg-secondary/30 transition-colors',
        isDraggedOver && 'ring-2 ring-ring bg-secondary/50',
      )}
    >
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-medium">{t(stageConfig[stage].labelKey)}</span>
        <span className="text-muted-foreground text-xs">({threads.length})</span>
        {projects.length > 0 && stage !== 'review' && stage !== 'done' && stage !== 'archived' && (
          <AddThreadButton
            projectId={projectId}
            projects={projects}
            onSelect={(pid) => onAddThread(pid, stage)}
          />
        )}
      </div>

      <div ref={scrollRef} className="min-h-[200px] flex-1 space-y-2 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-xs">
            {t('kanban.emptyColumn')}
          </div>
        ) : (
          <>
            {visibleThreads.map((thread) => (
              <KanbanCard
                key={thread.id}
                thread={thread}
                projectInfo={projectInfoById?.[thread.projectId]}
                onDelete={onDelete}
                onArchive={stage !== 'archived' ? onArchive : undefined}
                search={search}
                ghost={stage === 'archived'}
                contentSnippet={contentSnippets?.get(thread.id)}
                projectId={projectId}
                highlighted={thread.id === highlightThreadId}
                stage={stage}
                gitStatus={statusByThread[thread.id]}
              />
            ))}
            {hasMore && (
              <button
                data-testid={`kanban-load-more-${stage}`}
                onClick={() => setVisibleCount((prev) => prev + 20)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground w-full rounded-md py-2 text-xs transition-colors"
              >
                {t('kanban.loadMore', { count: Math.min(20, threads.length - visibleCount) })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});
