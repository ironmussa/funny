import type { FactoryRun } from '@funny/shared/contracts/factory';

/**
 * How a factory's integration went over a period of runs: outcomes, time in
 * the queue and to merge, and what integrating cost (CI rounds, red checks,
 * conflicts, agent fixes). Pure: computed from the runs the client already
 * has, so it needs no endpoint of its own.
 */
export interface FactoryMetricsSummary {
  /** Runs started inside the period. */
  runs: number;
  merged: number;
  waitingHuman: number;
  failed: number;
  stopped: number;
  /** Merged over runs that ended (merged, failed, stopped or waiting for a person); null when none ended. */
  mergeRate: number | null;
  /** Median time a sent issue waited in the queue before its flow started. */
  medianQueueMs: number | null;
  /** Median time from admission to merge, over merged runs. */
  medianToMergeMs: number | null;
  /** Average CI rounds per run that reached CI. */
  avgCiRounds: number | null;
  /** Share of CI rounds that ended red (failing checks). */
  redRate: number | null;
  /** Share of runs that reached CI and hit a conflict with their base branch at least once. */
  conflictRate: number | null;
  /** Average agent fixes (follow-ups after the PR opened) per run that reached CI. */
  avgAgentFixes: number | null;
  /** Share of integration conflicts settled without an agent (merge driver, rerere, regenerator). */
  settledWithoutAgentRate: number | null;
  /** Average size of the merge queue batch a run was last in, over the runs batched. */
  avgBatchSize: number | null;
  /** Median time a batched run spent in merge queue batches. */
  medianBatchWaitMs: number | null;
}

export const DEFAULT_METRICS_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** Milliseconds from `from` to `to`, or null when either is missing or the order is wrong. */
function span(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function summarizeFactoryRuns(
  runs: readonly FactoryRun[],
  options: { now?: number; windowDays?: number } = {},
): FactoryMetricsSummary {
  const now = options.now ?? Date.now();
  const since = now - (options.windowDays ?? DEFAULT_METRICS_WINDOW_DAYS) * DAY_MS;
  const inWindow = runs.filter((run) => Date.parse(run.startedAt) >= since);

  const count = (state: FactoryRun['state']) => inWindow.filter((r) => r.state === state).length;
  const merged = count('merged');
  const waitingHuman = count('waiting_human');
  const failed = count('failed');
  const stopped = count('stopped');

  // One pass each: keep the runs that count, and only the spans that could be measured.
  const queueTimes = inWindow.flatMap((run) => {
    const ms = run.source === 'manual' ? span(run.startedAt, run.admittedAt) : null;
    return ms === null ? [] : [ms];
  });
  const mergeTimes = inWindow.flatMap((run) => {
    const ms =
      run.state === 'merged' ? span(run.admittedAt ?? run.startedAt, run.completedAt) : null;
    return ms === null ? [] : [ms];
  });

  const reachedCi = inWindow.filter((run) => run.metrics.ciRounds > 0);
  const ciRounds = reachedCi.reduce((sum, run) => sum + run.metrics.ciRounds, 0);
  const ciRed = reachedCi.reduce((sum, run) => sum + run.metrics.ciRed, 0);
  const fixes = reachedCi.reduce((sum, run) => sum + run.metrics.agentFixes, 0);
  const withConflict = reachedCi.filter((run) => run.metrics.conflicts > 0).length;

  const settled = inWindow.reduce((sum, run) => sum + run.metrics.conflictsResolvedWithoutLlm, 0);
  const toAgent = inWindow.reduce((sum, run) => sum + run.metrics.conflictsSentToAgent, 0);
  const batched = inWindow.filter((run) => run.metrics.batchSize > 0);
  const batchSizes = batched.reduce((sum, run) => sum + run.metrics.batchSize, 0);

  return {
    runs: inWindow.length,
    merged,
    waitingHuman,
    failed,
    stopped,
    mergeRate: ratio(merged, merged + waitingHuman + failed + stopped),
    medianQueueMs: median(queueTimes),
    medianToMergeMs: median(mergeTimes),
    avgCiRounds: ratio(ciRounds, reachedCi.length),
    redRate: ratio(ciRed, ciRounds),
    conflictRate: ratio(withConflict, reachedCi.length),
    avgAgentFixes: ratio(fixes, reachedCi.length),
    settledWithoutAgentRate: ratio(settled, settled + toAgent),
    avgBatchSize: ratio(batchSizes, batched.length),
    medianBatchWaitMs: median(batched.map((run) => run.metrics.queueWaitMs)),
  };
}
