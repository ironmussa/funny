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
  | 'waiting_parts'
  | 'on_hold'
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
  'waiting_parts',
  'on_hold',
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
  // The team settles open product decisions with the spec writer (openspec factory-spec-stage).
  needs_spec: 'needs_person',
  waiting_human: 'needs_person',
  failed: 'needs_person',
  no_change: 'needs_person',
  merged: 'done',
  done: 'done',
  stopped: 'done',
  // Put on hold by a person: it asks nothing of anyone until it is released.
  on_hold: 'on_hold',
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
  'id' | 'factoryId' | 'issueNumber' | 'state' | 'failureReason' | 'startedAt' | 'triage'
>;

/**
 * The issues a run handed its issue's work to: the parts triage opened
 * (`splitInto`) and the existing issues it found tracking the work
 * (`existing`). Empty unless the run ended `done` that way.
 */
function factoryRunDelegatedParts(run: Pick<FactoryRun, 'state' | 'triage'>): number[] {
  if (run.state !== 'done') return [];
  return [...new Set([...(run.triage?.splitInto ?? []), ...(run.triage?.existing ?? [])])];
}

/**
 * The parts of each delegating run whose work is not finished, as far as the
 * listed runs say: a part is finished when the latest listed run of its issue,
 * in the same factory, merged or ended done without delegating in turn.
 */
function unfinishedParts<R extends PlacedRun>(runs: readonly R[]): ReadonlyMap<string, number[]> {
  const latest = new Map<string, R>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    const key = `${run.factoryId}#${run.issueNumber}`;
    const current = latest.get(key);
    if (!current || Date.parse(run.startedAt) > Date.parse(current.startedAt)) latest.set(key, run);
  }
  const finished = (factoryId: string, issue: number): boolean => {
    const run = latest.get(`${factoryId}#${issue}`);
    if (!run) return false;
    return (
      run.state === 'merged' || (run.state === 'done' && factoryRunDelegatedParts(run).length === 0)
    );
  };
  const open = new Map<string, number[]>();
  for (const run of runs) {
    // The factory closed the issue once all its parts were closed.
    if (run.triage?.partsClosedAt) continue;
    const parts = factoryRunDelegatedParts(run).filter((n) => !finished(run.factoryId, n));
    if (parts.length > 0) open.set(run.id, parts);
  }
  return open;
}

type ReplaceableRun = Pick<FactoryRun, 'id' | 'factoryId' | 'issueNumber' | 'startedAt'>;

/**
 * Each run a later-sent run of the same issue, in the same factory, replaced,
 * with the newest run of that issue (the server's `replacementOf` decides the
 * same from its own rows before it closes the replaced run's pull request).
 */
export function factoryRunReplacements<R extends ReplaceableRun>(
  runs: readonly R[],
): ReadonlyMap<string, R> {
  const keyOf = (run: R) => `${run.factoryId}#${run.issueNumber}`;
  const newest = new Map<string, R>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    const current = newest.get(keyOf(run));
    if (!current || Date.parse(run.startedAt) > Date.parse(current.startedAt)) {
      newest.set(keyOf(run), run);
    }
  }
  const replaced = new Map<string, R>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    const latest = newest.get(keyOf(run))!;
    if (Date.parse(run.startedAt) < Date.parse(latest.startedAt)) replaced.set(run.id, latest);
  }
  return replaced;
}

/**
 * Each run's column among the listed runs. A run stopped after a failure still
 * needs fixing, so it waits for a person, not in Done. A run a newer run of
 * its issue replaced (the issue was sent again) asks nothing of anyone: an
 * ended one goes to Done. A run that handed its issue's work to other issues
 * (split, or tracked by existing ones) waits for them until each is finished.
 */
export function placeFactoryRuns<R extends PlacedRun>(
  runs: readonly R[],
): Map<string, FactoryBoardColumnId> {
  const superseded = factoryRunReplacements(runs);
  const waiting = unfinishedParts(runs);
  const placed = new Map<string, FactoryBoardColumnId>();
  for (const run of runs) {
    if (waiting.has(run.id) && !superseded.has(run.id)) {
      placed.set(run.id, 'waiting_parts');
      continue;
    }
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
    waiting_parts: [],
    on_hold: [],
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
