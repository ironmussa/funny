import type { Project, ThreadStage } from '@funny/shared';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { BoardColumn } from '@/components/board/BoardColumn';
import { stageConfig } from '@/lib/thread-utils';

import { AddThreadButton } from './AddThreadButton';

/** A thread kanban column: the shared board column, titled by its stage, with the add-thread button. */
export function KanbanColumnSurface({
  columnRef,
  scrollRef,
  isDraggedOver,
  children,
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
  columnRef: Ref<HTMLDivElement>;
  scrollRef: Ref<HTMLDivElement>;
  isDraggedOver: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <BoardColumn
      testId={`kanban-column-${stage}`}
      title={t(stageConfig[stage].labelKey)}
      count={count}
      columnRef={columnRef}
      scrollRef={scrollRef}
      highlighted={isDraggedOver}
      headerExtra={
        projects.length > 0 &&
        !['review', 'done', 'archived'].includes(stage) && (
          <AddThreadButton
            projectId={projectId}
            projects={projects}
            onSelect={(id) => onAddThread(id, stage)}
          />
        )
      }
    >
      {children}
    </BoardColumn>
  );
}
