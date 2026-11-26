/**
 * Why an issue waits for its blockers (change factory-manual-queue): finished =
 * closed or merged here, the reason shown for each kind of unfinished blocker,
 * cycles through the queue, and other repositories.
 */
import { describe, expect, test } from 'bun:test';

import type { IssueBlocker } from '@funny/core/github-app';

import { inCycle, waitReasonFor } from '../../../services/factory/factory-dependencies.js';
import type { FactoryRunView } from '../../../services/factory/factory-runs.js';
import type { FactoryRunState } from '../../../services/factory/factory-runs.js';
import { delegatedWork } from '../../../services/factory/factory-watcher-admission.js';

const open = (number: number, repo = 'o/r'): IssueBlocker => ({ number, repo, open: true });
const closed = (number: number): IssueBlocker => ({ number, repo: 'o/r', open: false });

function reason(blockers: IssueBlocker[] | null, latest: Record<number, FactoryRunState> = {}) {
  return waitReasonFor({
    repo: 'o/r',
    issue: 10,
    blockers,
    latestRuns: new Map(Object.entries(latest).map(([n, state]) => [Number(n), state])),
    queueGraph: new Map(),
  });
}

describe('waitReasonFor', () => {
  test('no blockers, or only finished ones, let the issue start', () => {
    expect(reason([])).toBeNull();
    expect(reason([closed(1)])).toBeNull();
    // Merged here counts as finished even while GitHub still shows the issue open.
    expect(reason([open(1)], { 1: 'merged' })).toBeNull();
  });

  test.each([
    [undefined, 'blocker-not-sent'],
    ['requested', 'blocker-in-progress'],
    ['working', 'blocker-in-progress'],
    ['waiting_ci', 'blocker-in-progress'],
    ['waiting_human', 'blocker-waiting-merge'],
    ['failed', 'blocker-failed'],
    ['stopped', 'blocker-failed'],
  ] as const)('a blocker whose latest run is %s → %s', (latest, kind) => {
    expect(reason([open(1)], latest ? { 1: latest } : {})).toEqual({ kind, blockers: [1] });
  });

  test('a blocker whose run handed its work to other issues is in progress, not failed', () => {
    expect(
      waitReasonFor({
        repo: 'o/r',
        issue: 10,
        blockers: [open(1)],
        latestRuns: new Map([[1, 'done']]),
        delegated: new Set([1]),
        queueGraph: new Map(),
      }),
    ).toEqual({ kind: 'blocker-in-progress', blockers: [1] });
    expect(reason([open(1)], { 1: 'done' })).toEqual({ kind: 'blocker-failed', blockers: [1] });
  });

  test('the most actionable reason is shown when several blockers hold the issue', () => {
    expect(reason([open(1), open(2), open(3)], { 1: 'working', 2: 'failed' })).toEqual({
      kind: 'blocker-not-sent',
      blockers: [3],
    });
    expect(reason([open(1), open(2)], { 1: 'working', 2: 'failed' })).toEqual({
      kind: 'blocker-failed',
      blockers: [2],
    });
  });

  test('a blocker in another repository counts by its state only', () => {
    expect(reason([open(4, 'other/lib')])).toEqual({ kind: 'blocker-other-repo', blockers: [4] });
    expect(reason([{ number: 4, repo: 'other/lib', open: false }])).toBeNull();
  });

  test('unreadable blockers hold the issue', () => {
    expect(reason(null)).toEqual({ kind: 'blockers-unreadable', blockers: [] });
  });

  test('a cycle through the queue is reported as circular', () => {
    const queueGraph = new Map([
      [10, [11]],
      [11, [12]],
      [12, [10]],
    ]);
    expect(
      waitReasonFor({
        repo: 'o/r',
        issue: 10,
        blockers: [open(11)],
        latestRuns: new Map([[11, 'requested']]),
        queueGraph,
      }),
    ).toEqual({ kind: 'circular', blockers: [11] });
  });
});

describe('inCycle', () => {
  test('follows edges and stops on a chain without a loop', () => {
    expect(
      inCycle(
        1,
        new Map([
          [1, [2]],
          [2, [3]],
        ]),
      ),
    ).toBe(false);
    expect(
      inCycle(
        1,
        new Map([
          [1, [2]],
          [2, [1]],
        ]),
      ),
    ).toBe(true);
    // A loop that does not include the issue is not its cycle.
    expect(
      inCycle(
        1,
        new Map([
          [1, [2]],
          [2, [3]],
          [3, [2]],
        ]),
      ),
    ).toBe(false);
  });
});

describe('delegatedWork', () => {
  const at = '2026-11-25T00:00:00.000Z';
  const run = (state: FactoryRunState, triage: FactoryRunView['triage']) => ({ state, triage });

  test('a done run that split its issue or found it tracked elsewhere delegated its work', () => {
    expect(
      delegatedWork(run('done', { decision: 'too_big', at, items: [], existing: [542] })),
    ).toBe(true);
    expect(
      delegatedWork(run('done', { decision: 'too_big', at, items: ['a'], splitInto: [40] })),
    ).toBe(true);
  });

  test('any other run did not', () => {
    expect(delegatedWork(run('done', { decision: 'already_done', at, items: ['x'] }))).toBe(false);
    expect(
      delegatedWork(run('needs_info', { decision: 'too_big', at, items: ['a'], existing: [5] })),
    ).toBe(false);
    expect(delegatedWork(run('failed', null))).toBe(false);
  });
});
