/**
 * How the factory's runs hold each other back, read from the listed runs: a
 * queued run's `waitReason.blockers` names the issues it waits on (GitHub's
 * "blocked by", or a run working on the same files). This module answers both
 * directions for a card or the detail panel: what a run waits on, and whether
 * that blocker is itself stuck (it needs a person), and which issues wait on a
 * run, directly and further down the chain.
 */
import type { FactoryQueueRun } from '@/lib/api/factory';

/** States in which a run will not move until a person acts. */
const NEEDS_PERSON: ReadonlySet<FactoryQueueRun['state']> = new Set([
  'waiting_human',
  'failed',
  'stopped',
  'needs_info',
  'no_change',
]);

/** Wait reasons whose `blockers` are issues of the same repository with runs here. */
const HELD_BY_RUNS: ReadonlySet<NonNullable<FactoryQueueRun['waitReason']>['kind']> = new Set([
  'blocker-in-progress',
  'blocker-waiting-merge',
  'blocker-failed',
  'paths-overlap',
  'paths-awaiting-approval',
]);

export interface FactoryRunBlocker {
  issue: number;
  /** The blocker's latest run in this factory, when it is listed. */
  run: FactoryQueueRun | undefined;
  /** True when that run waits for a person: nothing moves until someone acts on it. */
  stuck: boolean;
}

export interface FactoryRunDependencies {
  /** What a queued run waits on; empty when it does not wait on another issue. */
  blockedBy: FactoryRunBlocker[];
  /** Issues whose queued run waits directly on this run's issue. */
  blocks: number[];
  /** Issues held further down the chain (they wait on one of `blocks`, and so on). */
  blocksLater: number[];
}

/** A run in these states no longer holds any issue back. */
const RELEASED: ReadonlySet<FactoryQueueRun['state']> = new Set(['merged', 'done']);

const NONE: FactoryRunDependencies = { blockedBy: [], blocks: [], blocksLater: [] };

/** True when the run waits for a person (a parked, failed or stopped run). */
export function isFactoryRunStuck(run: Pick<FactoryQueueRun, 'state'>): boolean {
  return NEEDS_PERSON.has(run.state);
}

const key = (factoryId: string, issue: number) => `${factoryId}#${issue}`;

function heldBy(run: FactoryQueueRun): number[] {
  if (run.state !== 'requested' || !run.waitReason) return [];
  return HELD_BY_RUNS.has(run.waitReason.kind) ? run.waitReason.blockers : [];
}

/** The latest run of each issue, per factory: the one that decides whether it blocks. */
function latestByIssue(runs: readonly FactoryQueueRun[]): Map<string, FactoryQueueRun> {
  const latest = new Map<string, FactoryQueueRun>();
  for (const run of runs) {
    if (run.issueNumber === null) continue;
    const k = key(run.factoryId, run.issueNumber);
    const seen = latest.get(k);
    if (!seen || run.startedAt > seen.startedAt) latest.set(k, run);
  }
  return latest;
}

/** Which issues wait directly on each issue, per factory. */
function waitersByIssue(latest: ReadonlyMap<string, FactoryQueueRun>): Map<string, number[]> {
  const waiters = new Map<string, number[]>();
  for (const run of latest.values()) {
    if (run.issueNumber === null) continue;
    for (const blocker of heldBy(run)) {
      const k = key(run.factoryId, blocker);
      const list = waiters.get(k) ?? [];
      list.push(run.issueNumber);
      waiters.set(k, list);
    }
  }
  return waiters;
}

/** Every issue held behind `issue`, split into the direct waiters and the rest of the chain. */
function heldBehind(
  factoryId: string,
  issue: number,
  waiters: ReadonlyMap<string, number[]>,
): Pick<FactoryRunDependencies, 'blocks' | 'blocksLater'> {
  const blocks = [...(waiters.get(key(factoryId, issue)) ?? [])].sort((a, b) => a - b);
  const seen = new Set<number>([issue, ...blocks]);
  const later: number[] = [];
  const pending = [...blocks];
  while (pending.length > 0) {
    const next = pending.shift()!;
    for (const waiter of waiters.get(key(factoryId, next)) ?? []) {
      if (seen.has(waiter)) continue;
      seen.add(waiter);
      later.push(waiter);
      pending.push(waiter);
    }
  }
  return { blocks, blocksLater: later.sort((a, b) => a - b) };
}

/**
 * Builds the lookup once for a list of runs. Pass every listed run, not only
 * the filtered ones, so a blocker hidden by a filter still counts.
 */
export interface FactoryRunDependencyLookup {
  of: (run: FactoryQueueRun) => FactoryRunDependencies;
  /** The latest listed run of an issue in a factory, to open it from a dependency. */
  runOf: (factoryId: string, issue: number) => FactoryQueueRun | undefined;
}

export function factoryRunDependencies(
  runs: readonly FactoryQueueRun[],
): FactoryRunDependencyLookup {
  const latest = latestByIssue(runs);
  const waiters = waitersByIssue(latest);
  const runOf = (factoryId: string, issue: number) => latest.get(key(factoryId, issue));
  const of = (run: FactoryQueueRun): FactoryRunDependencies => {
    const blockedBy = heldBy(run).map((issue) => {
      const blocker = latest.get(key(run.factoryId, issue));
      return { issue, run: blocker, stuck: blocker ? isFactoryRunStuck(blocker) : false };
    });
    // A merged run, or an older run of an issue, holds nothing back; a failed or stopped one still does.
    const current =
      run.issueNumber !== null &&
      !RELEASED.has(run.state) &&
      latest.get(key(run.factoryId, run.issueNumber))?.id === run.id;
    const behind =
      current && run.issueNumber !== null
        ? heldBehind(run.factoryId, run.issueNumber, waiters)
        : { blocks: [], blocksLater: [] };
    if (blockedBy.length === 0 && behind.blocks.length === 0) return NONE;
    return { blockedBy, ...behind };
  };
  return { of, runOf };
}

/** For views without the run list (stories, a lone panel): no dependencies. */
export const NO_FACTORY_RUN_DEPENDENCIES: FactoryRunDependencyLookup = {
  of: () => NONE,
  runOf: () => undefined,
};

/** An ANSI color sequence (ESC [ … m): the runner records hook output with its colors. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** A recorded reason without terminal colors or box-drawing frames (hook output keeps both). */
export function plainFactoryReason(text: string): string {
  return text
    .replace(ANSI_COLOR, '')
    .replace(/[\u2500-\u257f]+/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() !== '' || lines[index - 1]?.trim() !== '')
    .join('\n')
    .trim();
}

/** A recorded reason cut to its first line, for one line of a card. */
export function shortFactoryReason(text: string, max = 140): string {
  const line =
    plainFactoryReason(text)
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
