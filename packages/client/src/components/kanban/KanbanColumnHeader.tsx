import type { Project, ThreadStage } from '@funny/shared';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { stageConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { AddThreadButton } from './AddThreadButton';

function KanbanColumnHeader({
  stage,
  count,
  projectId,
  projects,
  onAddThread,
}: {
  stage: ThreadStage;
  count: number;
  projectId?: string;
  projects: Project[];
  onAddThread: (projectId: string, stage: ThreadStage) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2.5">
      <span className="text-sm font-medium">{t(stageConfig[stage].labelKey)}</span>
      <span className="text-muted-foreground text-xs">({count})</span>
      {projects.length > 0 && !['review', 'done', 'archived'].includes(stage) && (
        <AddThreadButton
          projectId={projectId}
          projects={projects}
          onSelect={(id) => onAddThread(id, stage)}
        />
      )}
    </div>
  );
}

export function KanbanColumnSurface({
  columnRef,
  scrollRef,
  isDraggedOver,
  children,
  ...header
}: ComponentProps<typeof KanbanColumnHeader> & {
  columnRef: Ref<HTMLDivElement>;
  scrollRef: Ref<HTMLDivElement>;
  isDraggedOver: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={columnRef}
      className={cn(
        'flex flex-col w-92 min-w-92 shrink-0 rounded-lg bg-secondary/30 transition-colors',
        isDraggedOver && 'ring-2 ring-ring bg-secondary/50',
      )}
    >
      <KanbanColumnHeader {...header} />
      <div ref={scrollRef} className="min-h-[200px] flex-1 space-y-2 overflow-y-auto p-2">
        {header.count === 0 ? (
          <EmptyState fill={false} className="py-8" title={t('kanban.emptyColumn')} />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
