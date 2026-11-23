/**
 * What the board and the run panel say about time (openspec
 * factory-step-timings, D3), from a run's step timings: how long the run has
 * been in its current step, its executions with their durations and the waits
 * between them, and the median time per stage.
 */
import type { FactoryRun, FactoryStepTiming } from '@funny/shared/contracts/factory';

import { type FactoryBoardColumnId, factoryBoardColumn } from './board-columns';
import { stageOfStep, TIMED_COLUMNS } from './step-stage';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A gap between two executions shorter than this is not shown as a wait. */
const MIN_WAIT_MS = 60_000;

const at = (iso: string) => Date.parse(iso);

export type TimeInStep = { kind: 'in-step' | 'waiting'; since: number };

/**
 * Since when the run has been in its current step (the latest execution of
 * that step), or waiting for it (no execution yet: since the latest one ended).
 */
export function timeInCurrentStep(
  run: Pick<FactoryRun, 'state' | 'currentStep' | 'stepTimings'>,
): TimeInStep | null {
  const timings = run.stepTimings;
  if (!timings?.length || !run.currentStep) return null;
  if (!TIMED_COLUMNS.includes(factoryBoardColumn(run.state))) return null;
  const current = timings.findLast((timing) => timing.step === run.currentStep);
  if (current) return { kind: 'in-step', since: at(current.startedAt) };
  const ended = timings.flatMap((timing) => (timing.finishedAt ? [at(timing.finishedAt)] : []));
  return ended.length > 0 ? { kind: 'waiting', since: Math.max(...ended) } : null;
}

export interface TimelineEntry {
  timing: FactoryStepTiming;
  /** Up to `now` while it runs. */
  durationMs: number;
  /** The wait before this execution, when it is a minute or more. */
  waitBeforeMs?: number;
}

export function stepTimeline(run: Pick<FactoryRun, 'stepTimings'>, now: number): TimelineEntry[] {
  const timings = run.stepTimings ?? [];
  let lastEnd: number | null = null;
  return timings.map((timing) => {
    const start = at(timing.startedAt);
    const end = timing.finishedAt ? at(timing.finishedAt) : now;
    const entry: TimelineEntry = { timing, durationMs: Math.max(0, end - start) };
    if (lastEnd !== null && start - lastEnd >= MIN_WAIT_MS) entry.waitBeforeMs = start - lastEnd;
    if (timing.finishedAt) lastEnd = Math.max(lastEnd ?? 0, end);
    return entry;
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The time one run spent in each stage, over its executions that ended in the last week. */
function stageTimesOf(run: Pick<FactoryRun, 'stepTimings'>, now: number) {
  const times = new Map<FactoryBoardColumnId, number>();
  for (const timing of run.stepTimings ?? []) {
    const stage = stageOfStep(timing.step);
    if (!stage || !timing.finishedAt || now - at(timing.finishedAt) > WEEK_MS) continue;
    const spent = at(timing.finishedAt) - at(timing.startedAt);
    times.set(stage, (times.get(stage) ?? 0) + Math.max(0, spent));
  }
  return times;
}

/** The median time runs spent in each timed stage over the last week; absent when nothing to measure. */
export function stageMedians(
  runs: readonly Pick<FactoryRun, 'stepTimings'>[],
  now: number,
): Partial<Record<FactoryBoardColumnId, number>> {
  const perStage = new Map<FactoryBoardColumnId, number[]>();
  for (const run of runs) {
    for (const [stage, spent] of stageTimesOf(run, now)) {
      perStage.set(stage, [...(perStage.get(stage) ?? []), spent]);
    }
  }
  const medians: Partial<Record<FactoryBoardColumnId, number>> = {};
  for (const [stage, values] of perStage) {
    const value = median(values);
    if (value !== null) medians[stage] = value;
  }
  return medians;
}

/** A duration to read at a glance: hours and minutes, minutes, or under a minute. */
export function formatStepDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1m';
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
