/**
 * How the factory's runs hold each other back (run-dependencies.ts): what a
 * queued run waits on and whether that blocker is stuck, and which issues wait
 * on a run, directly and down the chain.
 */
import { describe, expect, test } from 'bun:test';

import {
  factoryRunDependencies,
  plainFactoryReason,
  shortFactoryReason,
} from '@/components/factory-board/run-dependencies';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryWaitReason } from '@/lib/api/factory';

const run = (
  id: string,
  issueNumber: number,
  state: FactoryQueueRun['state'],
  over: Partial<FactoryQueueRun> = {},
): FactoryQueueRun => ({
  ...buildFactoryRun({ id, issueNumber, state, completedAt: null }),
  projectId: 'p1',
  ...over,
});

const waiting = (id: string, issue: number, kind: FactoryWaitReason['kind'], blockers: number[]) =>
  run(id, issue, 'requested', { waitReason: { kind, blockers } });

// The thread-recap chain as it stood: #434 parked after its integrate step failed,
// #435 and #437 waiting on its pull request, #436 waiting on #435.
const chain = () => [
  run('r434', 434, 'waiting_human', { failureReason: 'integrate[integrate] failed: hook' }),
  waiting('r435', 435, 'blocker-waiting-merge', [434]),
  waiting('r437', 437, 'blocker-waiting-merge', [434]),
  waiting('r436', 436, 'blocker-in-progress', [435]),
];

describe('factoryRunDependencies', () => {
  test('a stuck blocker lists what it holds back, directly and further down the chain', () => {
    const runs = chain();
    const deps = factoryRunDependencies(runs).of(runs[0]!);
    expect(deps.blocks).toEqual([435, 437]);
    expect(deps.blocksLater).toEqual([436]);
    expect(deps.blockedBy).toEqual([]);
  });

  test('a queued run names its blocker and that the blocker is stuck', () => {
    const runs = chain();
    const lookup = factoryRunDependencies(runs);
    const deps = lookup.of(runs[1]!);
    expect(deps.blockedBy).toEqual([{ issue: 434, run: runs[0], stuck: true }]);
    // #436 waits on #435, which is only queued: blocked, but not behind a stuck run.
    expect(lookup.of(runs[3]!).blockedBy).toEqual([{ issue: 435, run: runs[1], stuck: false }]);
    expect(lookup.of(runs[1]!).blocks).toEqual([436]);
  });

  test('a blocker that is still working is not stuck', () => {
    const runs = [run('b', 7, 'working'), waiting('w', 8, 'blocker-in-progress', [7])];
    expect(factoryRunDependencies(runs).of(runs[1]!).blockedBy[0]?.stuck).toBe(false);
  });

  test("only the issue's latest run counts, and a merged one holds nothing back", () => {
    const old = run('old', 7, 'stopped', { startedAt: '2026-01-01T00:00:00.000Z' });
    const merged = run('new', 7, 'merged', { startedAt: '2026-01-02T00:00:00.000Z' });
    const runs = [old, merged, waiting('w', 8, 'blocker-in-progress', [7])];
    const lookup = factoryRunDependencies(runs);
    expect(lookup.of(old).blocks).toEqual([]);
    expect(lookup.of(merged).blocks).toEqual([]);
    expect(lookup.runOf('f1', 7)).toBe(merged);
  });

  test('a failed blocker still holds its waiters back', () => {
    const runs = [run('b', 7, 'failed'), waiting('w', 8, 'blocker-failed', [7])];
    const lookup = factoryRunDependencies(runs);
    expect(lookup.of(runs[0]!).blocks).toEqual([8]);
    expect(lookup.of(runs[1]!).blockedBy[0]?.stuck).toBe(true);
  });

  test('issues of another factory are not mixed in', () => {
    const runs = [
      run('b', 7, 'waiting_human'),
      { ...waiting('w', 8, 'blocker-waiting-merge', [7]), factoryId: 'f2' },
    ];
    const lookup = factoryRunDependencies(runs);
    expect(lookup.of(runs[0]!).blocks).toEqual([]);
    expect(lookup.of(runs[1]!).blockedBy).toEqual([{ issue: 7, run: undefined, stuck: false }]);
  });

  test('a cycle ends', () => {
    const runs = [
      waiting('a', 1, 'blocker-in-progress', [2]),
      waiting('b', 2, 'blocker-in-progress', [1]),
    ];
    const deps = factoryRunDependencies(runs).of(runs[0]!);
    expect(deps.blocks).toEqual([2]);
    expect(deps.blocksLater).toEqual([]);
  });

  test('a reason that is not about other issues holds nothing', () => {
    const runs = [run('b', 7, 'working'), waiting('w', 8, 'proof-not-configured', [])];
    expect(factoryRunDependencies(runs).of(runs[0]!).blocks).toEqual([]);
  });
});

describe('factory reasons', () => {
  const hookOutput =
    'integrate[integrate] failed: Could not commit the merge: \u001b[38;2;56;56;56m╭──────╮\u001b[m\n' +
    '\u001b[38;2;56;56;56m│\u001b[m 🥊 lefthook \u001b[38;2;56;56;56m│\u001b[m\n\n\n' +
    'Invalid commit message format.';

  test('drop terminal colors and box frames', () => {
    expect(plainFactoryReason(hookOutput)).toBe(
      'integrate[integrate] failed: Could not commit the merge:\n 🥊 lefthook\n\nInvalid commit message format.',
    );
  });

  test('a card shows the first line, cut to its length', () => {
    expect(shortFactoryReason(hookOutput)).toBe(
      'integrate[integrate] failed: Could not commit the merge:',
    );
    expect(shortFactoryReason('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
