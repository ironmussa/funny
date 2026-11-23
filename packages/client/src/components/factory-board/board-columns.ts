/**
 * Which column of the factory board a run is in, and how each column orders
 * its runs (openspec factory-pipeline-board, D1). Read from the run's state,
 * never from its thread's stage, which folds every active step into one.
 */
import type { FactoryRun, FactoryRunState } from '@funny/shared/contracts/factory';

export type FactoryBoardColumnId =
  | 'queue'
  | 'triage'
  | 'implementing'
  | 'pr'
  | 'review'
  | 'merge'
  | 'needs_person'
  | 'done';

/** The board's columns, left to right. */
export const FACTORY_BOARD_COLUMNS: readonly FactoryBoardColumnId[] = [
  'queue',
  'triage',
  'implementing',
  'pr',
  'review',
  'merge',
  'needs_person',
  'done',
];

const COLUMN_OF = {
  requested: 'queue',
  queued: 'queue',
  triaging: 'triage',
  working: 'implementing',
  fixing: 'implementing',
  pr_open: 'pr',
  waiting_ci: 'pr',
  reviewing: 'review',
  merging: 'merge',
  needs_info: 'needs_person',
  waiting_human: 'needs_person',
  failed: 'needs_person',
  no_change: 'needs_person',
  merged: 'done',
  done: 'done',
  stopped: 'done',
} satisfies Record<FactoryRunState, FactoryBoardColumnId>;

const COLUMN_BY_STATE: ReadonlyMap<string, FactoryBoardColumnId> = new Map(
  Object.entries(COLUMN_OF),
);

/** The run's column; a state this client does not know goes to a person, never dropped. */
export function factoryBoardColumn(state: string): FactoryBoardColumnId {
  return COLUMN_BY_STATE.get(state) ?? 'needs_person';
}

/** How long a finished run stays in the Done column. */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The run's most recent activity: when it ended, was admitted, or was sent. */
export function factoryRunActivityAt(
  run: Pick<FactoryRun, 'completedAt' | 'admittedAt' | 'startedAt'>,
): number {
  return Date.parse(run.completedAt ?? run.admittedAt ?? run.startedAt);
}

export interface FactoryBoardLayout<R> {
  columns: Record<FactoryBoardColumnId, R[]>;
  /** Finished runs older than the Done window, left to the list. */
  hiddenDone: number;
}

/** The runs of each column, in the column's order: the queue's own, newest activity elsewhere. */
export function layoutFactoryBoard<R extends FactoryRun>(
  runs: readonly R[],
  now: number,
): FactoryBoardLayout<R> {
  const columns: Record<FactoryBoardColumnId, R[]> = {
    queue: [],
    triage: [],
    implementing: [],
    pr: [],
    review: [],
    merge: [],
    needs_person: [],
    done: [],
  };
  let hiddenDone = 0;
  for (const run of runs) {
    const column = factoryBoardColumn(run.state);
    if (column === 'done' && now - factoryRunActivityAt(run) > DONE_WINDOW_MS) {
      hiddenDone += 1;
      continue;
    }
    columns[column].push(run);
  }
  for (const id of FACTORY_BOARD_COLUMNS) {
    columns[id].sort((a, b) => factoryRunActivityAt(b) - factoryRunActivityAt(a));
  }
  // `queued` (admitted) runs go first: they are about to start; then the queue's order.
  columns.queue.sort(
    (a, b) =>
      Number(a.state === 'requested') - Number(b.state === 'requested') ||
      (a.queueOrder ?? 0) - (b.queueOrder ?? 0),
  );
  return { columns, hiddenDone };
}
