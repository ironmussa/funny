/**
 * Which column of the factory board a run is in, and how each column orders
 * its runs (openspec factory-pipeline-board, D1). Read from the run's state,
 * never from its thread's stage, which folds every active step into one.
 */
import type { FactoryRun, FactoryRunState } from '@funny/shared/contracts/factory';

import { isFactoryRunStoppedAfterFailure } from '@/lib/factory-run-labels';

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

type PlacedRun = Pick<
  FactoryRun,
  'id' | 'factoryId' | 'issueNumber' | 'state' | 'failureReason' | 'startedAt'
>;

/** The runs a later-sent run of the same issue, in the same factory, replaced. */
function supersededRuns(runs: readonly PlacedRun[]): ReadonlySet<string> {
  const keyOf = (run: PlacedRun) => `${run.factoryId}#${run.issueNumber}`;
  const latestStart = new Map<string, number>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    const key = keyOf(run);
    latestStart.set(key, Math.max(latestStart.get(key) ?? -Infinity, Date.parse(run.startedAt)));
  }
  const superseded = new Set<string>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    if (Date.parse(run.startedAt) < latestStart.get(keyOf(run))!) superseded.add(run.id);
  }
  return superseded;
}

/**
 * Each run's column among the listed runs. A run stopped after a failure still
 * needs fixing, so it waits for a person, not in Done. A run a newer run of
 * its issue replaced (the issue was sent again) asks nothing of anyone: an
 * ended one goes to Done.
 */
export function placeFactoryRuns<R extends PlacedRun>(
  runs: readonly R[],
): Map<string, FactoryBoardColumnId> {
  const superseded = supersededRuns(runs);
  const placed = new Map<string, FactoryBoardColumnId>();
  for (const run of runs) {
    const column = isFactoryRunStoppedAfterFailure(run)
      ? 'needs_person'
      : factoryBoardColumn(run.state);
    const ended = run.state === 'failed' || run.state === 'stopped' || run.state === 'no_change';
    placed.set(run.id, ended && superseded.has(run.id) ? 'done' : column);
  }
  return placed;
}

/** The run's most recent activity: when it ended, was admitted, or was sent. */
export function factoryRunActivityAt(
  run: Pick<FactoryRun, 'completedAt' | 'admittedAt' | 'startedAt'>,
): number {
  return Date.parse(run.completedAt ?? run.admittedAt ?? run.startedAt);
}

/**
 * The runs of each column, in the column's order: the queue's own, newest
 * activity elsewhere. Done holds every finished run; the column pages them in
 * as it scrolls.
 */
export function layoutFactoryBoard<R extends FactoryRun>(
  runs: readonly R[],
): Record<FactoryBoardColumnId, R[]> {
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
  const placed = placeFactoryRuns(runs);
  for (const run of runs) columns[placed.get(run.id)!].push(run);
  for (const id of FACTORY_BOARD_COLUMNS) {
    columns[id].sort((a, b) => factoryRunActivityAt(b) - factoryRunActivityAt(a));
  }
  // `queued` (admitted) runs go first: they are about to start; then the queue's order.
  columns.queue.sort(
    (a, b) =>
      Number(a.state === 'requested') - Number(b.state === 'requested') ||
      (a.queueOrder ?? 0) - (b.queueOrder ?? 0),
  );
  return columns;
}
