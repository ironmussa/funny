import { describe, expect, test } from 'bun:test';

import type {
  FactoryReviewVerdict,
  FactoryRun,
  FactoryStepOptionsRecord,
} from '@funny/shared/contracts/factory';

import { summarizeFactoryHealth } from '@/components/factory-board/factory-health';
import { factoryRunCardThreadLinks } from '@/components/factory-board/FactoryRunThreadLinks';
import { factoryRunThreadLinks } from '@/components/factory-board/run-detail/thread-links';
import { buildFactoryRun } from '@/data/factory/testing';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

const review = (sha: string, pass: boolean, threadId?: string): FactoryReviewVerdict => {
  const verdict: FactoryReviewVerdict = {
    sha,
    verdict: pass ? 'pass' : 'fail',
    findings: pass ? [] : [{ severity: 'high', title: 'bug' }],
    reviewedAt: hoursAgo(1),
  };
  if (threadId !== undefined) verdict.threadId = threadId;
  return verdict;
};

const step = (
  stepId: string,
  threadId: string,
  thread: 'continue' | 'new' = 'continue',
): FactoryStepOptionsRecord => ({
  stepId,
  threadId,
  provider: 'claude',
  model: 'opus',
  effort: null,
  permissionMode: 'autoEdit',
  allowedTools: null,
  disallowedTools: null,
  thread,
});

// Each run its own id and issue: the board places runs by id, and a later run
// of the same issue supersedes an ended one.
let runs = 0;
const run = (over: Partial<FactoryRun>) => {
  runs += 1;
  return buildFactoryRun({
    id: `run-${runs}`,
    issueNumber: runs,
    startedAt: hoursAgo(10),
    admittedAt: hoursAgo(9),
    completedAt: null,
    ...over,
  });
};

describe('summarizeFactoryHealth', () => {
  test('counts what is in flight, waiting for a person and merged in the last day', () => {
    const health = summarizeFactoryHealth(
      [
        run({ state: 'working' }),
        run({ state: 'reviewing' }),
        run({ state: 'requested' }),
        run({ state: 'failed' }),
        run({ state: 'waiting_human' }),
        run({ state: 'merged', completedAt: hoursAgo(2) }),
        run({ state: 'merged', completedAt: hoursAgo(30) }),
      ],
      NOW,
    );
    expect(health).toMatchObject({ inFlight: 2, needsPerson: 2, mergedLastDay: 1 });
  });

  test('first-pass review rate over last week, a dash without reviews', () => {
    const reviewed = [
      run({ reviews: [review('a', true)] }),
      run({ reviews: [review('b', true)] }),
      run({ reviews: [review('c', false), review('d', true)] }),
      // Started more than a week ago: not counted.
      run({ startedAt: hoursAgo(24 * 9), reviews: [review('e', false)] }),
    ];
    expect(summarizeFactoryHealth(reviewed, NOW).firstPassReviewRate).toBeCloseTo(2 / 3);
    expect(summarizeFactoryHealth([run({})], NOW).firstPassReviewRate).toBeNull();
  });

  test('merge holds and median time to merge count last week only', () => {
    const holds = (n: number, startedAt = hoursAgo(10)) => {
      const r = run({ startedAt });
      r.metrics = { ...r.metrics, mergeHolds: n };
      return r;
    };
    const health = summarizeFactoryHealth(
      [
        holds(2),
        holds(1),
        holds(5, hoursAgo(24 * 10)),
        run({ state: 'merged', admittedAt: hoursAgo(5), completedAt: hoursAgo(4) }),
        run({ state: 'merged', admittedAt: hoursAgo(5), completedAt: hoursAgo(2) }),
        run({ state: 'merged', admittedAt: hoursAgo(300), completedAt: hoursAgo(200) }),
      ],
      NOW,
    );
    expect(health.mergeHolds).toBe(3);
    expect(health.medianToMergeMs).toBe(2 * 3600_000);
  });
});

describe('factoryRunThreadLinks', () => {
  test('triage, one implementer across steps, one reviewer per review, each thread once', () => {
    const links = factoryRunThreadLinks({
      triage: { decision: 'ready', at: hoursAgo(9), threadId: 't-triage' },
      stepOptions: [
        step('triage', 't-triage', 'new'),
        step('implement', 't-impl'),
        step('address', 't-impl'),
        step('review', 't-rev-1', 'new'),
        step('review', 't-rev-2', 'new'),
      ],
      reviews: [review('a', false, 't-rev-1'), review('b', true, 't-rev-2')],
    });
    expect(links).toEqual([
      { threadId: 't-triage', role: 'triage', steps: ['triage'] },
      { threadId: 't-impl', role: 'implementer', steps: ['implement', 'address'] },
      { threadId: 't-rev-1', role: 'reviewer', steps: ['review'] },
      { threadId: 't-rev-2', role: 'reviewer', steps: ['review'] },
    ]);
  });
});

describe('factoryRunCardThreadLinks', () => {
  test('a card links the latest thread of each role', () => {
    const links = factoryRunCardThreadLinks({
      triage: { decision: 'ready', at: hoursAgo(9), threadId: 't-triage' },
      stepOptions: [
        step('triage', 't-triage', 'new'),
        step('implement', 't-impl'),
        step('review', 't-rev-1', 'new'),
        step('implement', 't-impl-retry'),
        step('review', 't-rev-2', 'new'),
      ],
      reviews: [review('a', false, 't-rev-1'), review('b', true, 't-rev-2')],
    });
    expect(links.map((link) => link.threadId)).toEqual(['t-triage', 't-impl-retry', 't-rev-2']);
  });
});
