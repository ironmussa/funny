/**
 * How the factory is flowing, over the runs the factory view lists (openspec
 * factory-run-detail, D4): what is in flight or needs a person now, what
 * merged in the last day, and over the last week how often a first review
 * passed, how often merge held a run, and the median time to merge.
 */
import type { FactoryRun } from '@funny/shared/contracts/factory';

import { factoryReviewPassed } from '@/lib/factory-run-labels';

import { placeFactoryRuns } from './board-columns';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface FactoryHealth {
  inFlight: number;
  needsPerson: number;
  mergedLastDay: number;
  /** Share of last week's reviewed runs whose first review passed; null with none reviewed. */
  firstPassReviewRate: number | null;
  /** Times merge left last week's runs for a person. */
  mergeHolds: number;
  /** Median admission-to-merge time over last week's merges; null with none. */
  medianToMergeMs: number | null;
}

const IN_FLIGHT = new Set(['triage', 'implementing', 'pr', 'review', 'merge']);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

export function summarizeFactoryHealth(runs: readonly FactoryRun[], now: number): FactoryHealth {
  const columns = [...placeFactoryRuns(runs).values()];
  const lastWeek = runs.filter((run) => now - at(run.startedAt) <= WEEK_MS);
  const reviewed = lastWeek.filter((run) => run.reviews.length > 0);
  const mergeTimes = runs.flatMap((run) => {
    const done = at(run.completedAt);
    const start = at(run.admittedAt ?? run.startedAt);
    if (run.state !== 'merged' || now - done > WEEK_MS || !(done >= start)) return [];
    return [done - start];
  });
  return {
    inFlight: columns.filter((column) => IN_FLIGHT.has(column)).length,
    needsPerson: columns.filter((column) => column === 'needs_person').length,
    mergedLastDay: runs.filter(
      (run) => run.state === 'merged' && now - at(run.completedAt) <= DAY_MS,
    ).length,
    firstPassReviewRate:
      reviewed.length === 0
        ? null
        : reviewed.filter((run) => factoryReviewPassed(run.reviews[0]!)).length / reviewed.length,
    mergeHolds: lastWeek.reduce((sum, run) => sum + run.metrics.mergeHolds, 0),
    medianToMergeMs: median(mergeTimes),
  };
}
