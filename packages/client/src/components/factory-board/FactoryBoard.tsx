/**
 * The factory view's board layout (openspec factory-pipeline-board): one
 * column per pipeline stage, each run placed by its state. Read-only: a run
 * changes column only when the server changes its state.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BoardColumn } from '@/components/board/BoardColumn';
import { Button } from '@/components/ui/button';
import { useFactorySettings } from '@/data/factory/hooks';
import type { FactoryQueueRun } from '@/lib/api/factory';

import {
  FACTORY_BOARD_COLUMNS,
  type FactoryBoardColumnId,
  layoutFactoryBoard,
} from './board-columns';
import { FactoryRunCard } from './FactoryRunCard';

/** Cards a column shows before "Show more". */
const PAGE = 50;

/** The flow node whose limit a column shows (the built-in flows' ids). */
const LIMIT_NODE: Partial<Record<FactoryBoardColumnId, string>> = {
  implementing: 'implement',
  review: 'review',
};

/** The project's limit for a column, when the view shows one project. */
function StageLimit({
  projectId,
  column,
  count,
}: {
  projectId: string;
  column: FactoryBoardColumnId;
  count: number;
}) {
  const { t } = useTranslation();
  const settings = useFactorySettings(projectId);
  if (!settings) return null;
  if (column === 'merge') {
    return (
      <span className="text-muted-foreground text-xs" data-testid={`factory-board-limit-${column}`}>
        {t('factoryBoard.limit.merge', '1 at a time per repository')}
      </span>
    );
  }
  const node = LIMIT_NODE[column];
  if (!node) return null;
  const limit = settings.stageLimits[node] ?? settings.maxConcurrent;
  return (
    <span
      className="text-muted-foreground text-xs"
      title={
        node in settings.stageLimits
          ? t('factoryBoard.limit.stage', 'Stage limit of "{{node}}"', { node })
          : t('factoryBoard.limit.max', "The factory's maximum concurrent runs")
      }
      data-testid={`factory-board-limit-${column}`}
    >
      {count}/{limit}
    </span>
  );
}

interface Props {
  runs: FactoryQueueRun[];
  projectNameById: ReadonlyMap<string, string>;
  now: number;
  /** The one project the view is filtered to: its limits show in the headers. */
  singleProjectId: string | null;
  onOpen: (run: FactoryQueueRun, threadId: string) => void;
  /** Shows the finished runs the Done column hides, in the list. */
  onShowOlderDone: () => void;
}

export function FactoryBoard({
  runs,
  projectNameById,
  now,
  singleProjectId,
  onOpen,
  onShowOlderDone,
}: Props) {
  const { t } = useTranslation();
  const { columns, hiddenDone } = layoutFactoryBoard(runs, now);
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const [shown, setShown] = useState<Partial<Record<FactoryBoardColumnId, number>>>({});
  const titles: Record<FactoryBoardColumnId, string> = {
    queue: t('factoryBoard.column.queue', 'Queue'),
    triage: t('factoryBoard.column.triage', 'Triage'),
    implementing: t('factoryBoard.column.implementing', 'Implementing'),
    pr: t('factoryBoard.column.pr', 'PR · Proof · CI'),
    review: t('factoryBoard.column.review', 'Review'),
    merge: t('factoryBoard.column.merge', 'Merge'),
    needs_person: t('factoryBoard.column.needsPerson', 'Needs a person'),
    done: t('factoryBoard.column.done', 'Done'),
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3" data-testid="factory-board">
      {FACTORY_BOARD_COLUMNS.map((id) => {
        const cards = columns[id];
        const limit = shown[id] ?? PAGE;
        const isDone = id === 'done';
        const collapsed = isDone && doneCollapsed;
        return (
          <BoardColumn
            key={id}
            testId={`factory-board-column-${id}`}
            title={
              isDone ? (
                <button
                  type="button"
                  className="flex items-center gap-1"
                  onClick={() => setDoneCollapsed((value) => !value)}
                  aria-expanded={!collapsed}
                  data-testid="factory-board-done-toggle"
                >
                  {collapsed ? (
                    <ChevronRight className="icon-xs" />
                  ) : (
                    <ChevronDown className="icon-xs" />
                  )}
                  {titles[id]}
                </button>
              ) : (
                titles[id]
              )
            }
            count={cards.length}
            collapsed={collapsed}
            className={collapsed ? 'w-auto min-w-0 self-start' : undefined}
            emptyTitle={t('factoryBoard.emptyColumn', 'No runs here')}
            headerExtra={
              <>
                {singleProjectId && (id === 'merge' || id in LIMIT_NODE) && (
                  <StageLimit projectId={singleProjectId} column={id} count={cards.length} />
                )}
                {isDone && hiddenDone > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground ml-auto text-xs underline-offset-2 hover:underline"
                    onClick={onShowOlderDone}
                    data-testid="factory-board-done-hidden"
                  >
                    {t('factoryBoard.doneHidden', '+{{count}} older in the list', {
                      count: hiddenDone,
                    })}
                  </button>
                )}
              </>
            }
          >
            {cards.slice(0, limit).map((run) => (
              <FactoryRunCard
                key={run.id}
                run={run}
                projectName={projectNameById.get(run.projectId)}
                now={now}
                onOpen={onOpen}
              />
            ))}
            {cards.length > limit && (
              <div className="flex justify-center">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setShown((prev) => ({ ...prev, [id]: limit + PAGE }))}
                  data-testid={`factory-board-more-${id}`}
                >
                  {t('factoryBoard.showMore', 'Show {{count}} more', {
                    count: Math.min(PAGE, cards.length - limit),
                  })}
                </Button>
              </div>
            )}
          </BoardColumn>
        );
      })}
    </div>
  );
}
