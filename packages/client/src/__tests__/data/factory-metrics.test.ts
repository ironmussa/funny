import { describe, expect, test } from 'bun:test';

import { EMPTY_FACTORY_RUN_METRICS, type FactoryRun } from '@funny/shared/contracts/factory';

import { summarizeFactoryRuns } from '@/data/factory/metrics';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const MIN = 60 * 1000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

let seq = 0;
function run(over: Partial<FactoryRun> = {}): FactoryRun {
  seq += 1;
  return {
    id: `r${seq}`,
    factoryId: 'f1',
    issueNumber: seq,
    issueTitle: null,
    triggerName: null,
    inputs: {},
    prUrl: null,
    state: 'merged',
    currentStep: null,
    threadIds: [],
    startedAt: at(120),
    admittedAt: at(120),
    completedAt: at(60),
    source: 'label',
    flowName: 'issue-to-merge',
    queueOrder: null,
    waitReason: null,
    flowSteps: [],
    failureReason: null,
    metrics: { ...EMPTY_FACTORY_RUN_METRICS },
    regressionProof: null,
    reviews: [],
    risk: null,
    triage: null,
    flowSource: null,
    flowCommit: null,
    stepOptions: [],
    mergeApproval: null,
    riskWaiver: null,
    ...over,
  };
}

describe('summarizeFactoryRuns', () => {
  test('counts outcomes and the merge rate over the runs that ended', () => {
    const summary = summarizeFactoryRuns(
      [
        run({ state: 'merged' }),
        run({ state: 'merged' }),
        run({ state: 'failed' }),
        run({ state: 'waiting_human' }),
        run({ state: 'working', completedAt: null }),
      ],
      { now: NOW },
    );
    expect(summary).toMatchObject({ runs: 5, merged: 2, failed: 1, waitingHuman: 1, stopped: 0 });
    expect(summary.mergeRate).toBe(0.5);
  });

  test('takes the median queue time of sent issues and the median time to merge', () => {
    const summary = summarizeFactoryRuns(
      [
        run({ source: 'manual', startedAt: at(100), admittedAt: at(90), completedAt: at(30) }),
        run({ source: 'manual', startedAt: at(100), admittedAt: at(70), completedAt: at(30) }),
        // A labelled run never waited in the queue: not part of the queue time.
        run({ source: 'label', startedAt: at(100), admittedAt: at(100), completedAt: at(40) }),
      ],
      { now: NOW },
    );
    expect(summary.medianQueueMs).toBe(20 * MIN);
    expect(summary.medianToMergeMs).toBe(60 * MIN);
  });

  test('averages CI rounds and fixes over the runs that reached CI, and rates red and conflicts', () => {
    const summary = summarizeFactoryRuns(
      [
        run({
          metrics: {
            ...EMPTY_FACTORY_RUN_METRICS,
            ciRounds: 3,
            ciRed: 1,
            conflicts: 1,
            agentFixes: 2,
          },
        }),
        run({ metrics: { ...EMPTY_FACTORY_RUN_METRICS, ciRounds: 1 } }),
        // Never reached CI: left out of the CI averages.
        run({ state: 'failed', metrics: { ...EMPTY_FACTORY_RUN_METRICS } }),
      ],
      { now: NOW },
    );
    expect(summary.avgCiRounds).toBe(2);
    expect(summary.redRate).toBe(0.25);
    expect(summary.conflictRate).toBe(0.5);
    expect(summary.avgAgentFixes).toBe(1);
  });

  // openspec factory-integration 6.2: integration without an agent, and the merge queue.
  test('conflicts settled with no agent, and the merge queue batches', () => {
    const metrics = EMPTY_FACTORY_RUN_METRICS;
    const summary = summarizeFactoryRuns(
      [
        run({
          metrics: {
            ...metrics,
            conflictsResolvedWithoutLlm: 3,
            conflictsSentToAgent: 1,
            batchSize: 4,
            queueWaitMs: 60_000,
          },
        }),
        run({ metrics: { ...metrics, batchSize: 2, queueWaitMs: 120_000 } }),
        // Never batched: out of the batch figures.
        run({ metrics: { ...metrics } }),
      ],
      { now: NOW },
    );
    expect(summary.settledWithoutAgentRate).toBe(0.75);
    expect(summary.avgBatchSize).toBe(3);
    expect(summary.medianBatchWaitMs).toBe(90_000);
  });

  test('leaves out runs started before the window, and answers null without data', () => {
    const old = run({ startedAt: new Date(NOW - 40 * 24 * 60 * MIN).toISOString() });
    const summary = summarizeFactoryRuns([old], { now: NOW, windowDays: 30 });
    expect(summary.runs).toBe(0);
    expect(summary.mergeRate).toBeNull();
    expect(summary.medianToMergeMs).toBeNull();
    expect(summary.avgCiRounds).toBeNull();
  });
});
