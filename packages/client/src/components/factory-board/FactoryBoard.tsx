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
import { stageMedians } from './step-timings';
import { StageMedian } from './StepTimeBadges';

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

/** The Done column's title: it folds the column away. */
function DoneTitle({
  title,
  collapsed,
  onToggle,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className="flex items-center gap-1"
      onClick={onToggle}
      aria-expanded={!collapsed}
      data-testid="factory-board-done-toggle"
    >
      <Chevron className="icon-xs" />
      {title}
    </button>
  );
}

/** The Done header's link to the finished runs it leaves to the list. */
function HiddenDone({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground ml-auto text-xs underline-offset-2 hover:underline"
      onClick={onShow}
      data-testid="factory-board-done-hidden"
    >
      {t('factoryBoard.doneHidden', '+{{count}} older in the list', { count })}
    </button>
  );
}

/** "Show N more" under a column's cards, when it has more than it shows. */
function ShowMore({
  column,
  hidden,
  onMore,
}: {
  column: FactoryBoardColumnId;
  hidden: number;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  if (hidden <= 0) return null;
  return (
    <div className="flex justify-center">
      <Button
        size="xs"
        variant="ghost"
        onClick={onMore}
        data-testid={`factory-board-more-${column}`}
      >
        {t('factoryBoard.showMore', 'Show {{count}} more', { count: Math.min(PAGE, hidden) })}
      </Button>
    </div>
  );
}

interface ColumnProps {
  id: FactoryBoardColumnId;
  title: string;
  cards: FactoryQueueRun[];
  projectNameById: ReadonlyMap<string, string>;
  now: number;
  singleProjectId: string | null;
  hiddenDone: number;
  /** The median time in this stage over the last week, when measured. */
  medianMs: number | undefined;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
  onShowOlderDone: () => void;
}

/** What a column header shows after its count: the stage's median, its limit, and Done's hidden runs. */
function StageHeaderExtra({
  id,
  count,
  medianMs,
  singleProjectId,
  hiddenDone,
  onShowOlderDone,
}: Pick<ColumnProps, 'id' | 'medianMs' | 'singleProjectId' | 'hiddenDone' | 'onShowOlderDone'> & {
  count: number;
}) {
  const limitProject = id === 'merge' || id in LIMIT_NODE ? singleProjectId : null;
  return (
    <>
      <StageMedian column={id} medianMs={medianMs} />
      {limitProject && <StageLimit projectId={limitProject} column={id} count={count} />}
      {id === 'done' && <HiddenDone count={hiddenDone} onShow={onShowOlderDone} />}
    </>
  );
}

/** One stage column: its cards a page at a time, its limit, and for Done the fold and hidden count. */
function FactoryBoardStage({
  id,
  title,
  cards,
  projectNameById,
  now,
  singleProjectId,
  hiddenDone,
  medianMs,
  onSelect,
  onShowOlderDone,
}: ColumnProps) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(PAGE);
  const [doneCollapsed, setDoneCollapsed] = useState(false);
  const isDone = id === 'done';
  const collapsed = isDone && doneCollapsed;
  const doneTitle = (
    <DoneTitle
      title={title}
      collapsed={collapsed}
      onToggle={() => setDoneCollapsed((value) => !value)}
    />
  );
  return (
    <BoardColumn
      testId={`factory-board-column-${id}`}
      title={isDone ? doneTitle : title}
      count={cards.length}
      collapsed={collapsed}
      className={collapsed ? 'w-auto min-w-0 self-start' : undefined}
      emptyTitle={t('factoryBoard.emptyColumn', 'No runs here')}
      headerExtra={
        <StageHeaderExtra
          id={id}
          count={cards.length}
          medianMs={medianMs}
          singleProjectId={singleProjectId}
          hiddenDone={hiddenDone}
          onShowOlderDone={onShowOlderDone}
        />
      }
    >
      {cards.slice(0, limit).map((run) => (
        <FactoryRunCard
          key={run.id}
          run={run}
          projectName={projectNameById.get(run.projectId)}
          now={now}
          onSelect={onSelect}
        />
      ))}
      <ShowMore
        column={id}
        hidden={cards.length - limit}
        onMore={() => setLimit((value) => value + PAGE)}
      />
    </BoardColumn>
  );
}

interface Props {
  runs: FactoryQueueRun[];
  projectNameById: ReadonlyMap<string, string>;
  now: number;
  /** The one project the view is filtered to: its limits show in the headers. */
  singleProjectId: string | null;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
  /** Shows the finished runs the Done column hides, in the list. */
  onShowOlderDone: () => void;
}

export function FactoryBoard({ runs, now, ...rest }: Props) {
  const { t } = useTranslation();
  const { columns, hiddenDone } = layoutFactoryBoard(runs, now);
  const medians = stageMedians(runs, now);
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
      {FACTORY_BOARD_COLUMNS.map((id) => (
        <FactoryBoardStage
          key={id}
          id={id}
          title={titles[id]}
          cards={columns[id]}
          now={now}
          hiddenDone={hiddenDone}
          medianMs={medians[id]}
          {...rest}
        />
      ))}
    </div>
  );
}
