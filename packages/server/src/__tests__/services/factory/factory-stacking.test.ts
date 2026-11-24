/**
 * Stacked pull requests (openspec factory-integration 5.2, D10): an issue
 * whose one blocker is in flight with a pull request starts on its branch;
 * the run waits for the blocker at the end of `ci`, parks if it ends without
 * merging, and is retargeted to the default branch before it merges.
 */
import { describe, expect, test } from 'bun:test';

import type { FactoryStackedOn, FactoryWaitReason } from '@funny/shared/contracts/factory';
import { ok, okAsync } from 'neverthrow';

import { integrateStacked } from '../../../services/factory/factory-early-watch.js';
import type { FactoryRunView } from '../../../services/factory/factory-runs.js';
import { createStacking, type BlockerState } from '../../../services/factory/factory-stacking.js';
import { busyPathsOf } from '../../../services/factory/factory-triage.js';
import { pathsHeld, stackTarget } from '../../../services/factory/factory-watcher.js';

const on: FactoryStackedOn = {
  runId: 'blocker-run',
  issueNumber: 7,
  branch: 'factory/issue-7-abcdef12',
  retargeted: false,
};

function stacking(states: BlockerState[], over: { retarget?: () => Promise<unknown> } = {}) {
  const recorded: unknown[] = [];
  const retargets: string[] = [];
  const queue = [...states];
  const stack = createStacking({
    stackedOn: on,
    defaultBranch: () => okAsync('main'),
    blockerState: async () => queue.shift() ?? 'merged',
    retarget: async (base) => {
      retargets.push(base);
      await over.retarget?.();
      return ok(undefined);
    },
    record: async (input) => {
      recorded.push(input);
    },
    signal: new AbortController().signal,
    pollMs: 1,
  });
  return { stack, recorded, retargets };
}

describe('a stacked run', () => {
  test("builds on its blocker's branch until the blocker lands, then on the default branch", async () => {
    const { stack } = stacking(['merged']);
    expect((await stack.base())?._unsafeUnwrap()).toBe('factory/issue-7-abcdef12');
    expect(stack.diffBase()).toBe('factory/issue-7-abcdef12');
    expect(await stack.retargetIfLanded()).toBe('retargeted');
    expect((await stack.base())?._unsafeUnwrap()).toBe('main');
    expect(stack.diffBase()).toBeNull();
  });

  test('waits at the end of ci while the blocker is in flight, and goes on once it merged', async () => {
    const { stack } = stacking(['in-flight', 'in-flight', 'merged']);
    expect(await stack.waitForBlocker()).toBeNull();
  });

  test('parks when the blocker ends without merging', async () => {
    const { stack } = stacking(['in-flight', 'gone']);
    expect(await stack.waitForBlocker()).toContain('(#7) ended without merging');
  });

  test('is retargeted to the default branch only once its blocker landed', async () => {
    const early = stacking(['in-flight']);
    expect(await early.stack.retargetIfLanded()).toEqual({
      error: expect.stringContaining('has not merged yet'),
    });
    expect(early.retargets).toEqual([]);
    const landed = stacking(['merged']);
    expect(await landed.stack.retargetIfLanded()).toBe('retargeted');
    expect(landed.retargets).toEqual(['main']);
    expect(landed.recorded).toEqual([{ stackedOn: { ...on, retargeted: true } }]);
    // Retargeted once: a later merge goes on as any run.
    expect(await landed.stack.retargetIfLanded()).toBe('not-stacked');
  });

  test('a run that is not stacked waits for nothing', async () => {
    const stack = createStacking({
      stackedOn: null,
      defaultBranch: () => okAsync('main'),
      record: async () => undefined,
      signal: new AbortController().signal,
    });
    expect(await stack.waitForBlocker()).toBeNull();
    expect(await stack.retargetIfLanded()).toBe('not-stacked');
    expect((await stack.base())?._unsafeUnwrap()).toBe('main');
  });
});

describe('admission with dependencies: stack', () => {
  const factory = (dependencies: 'wait' | 'stack') => ({ dependencies });
  type BlockerRun = Pick<FactoryRunView, 'id' | 'issueNumber' | 'state' | 'prUrl'>;
  const blockerRun = (over: Partial<BlockerRun> = {}): BlockerRun => ({
    id: 'blocker-run-id',
    issueNumber: 7,
    state: 'waiting_ci',
    prUrl: 'https://github.com/o/r/pull/70',
    ...over,
  });
  const ctx = (runs: BlockerRun[]) => ({ runs });
  const inProgress: FactoryWaitReason = { kind: 'blocker-in-progress', blockers: [7] };

  test('one blocker in flight with a pull request: stack on its branch', () => {
    expect(stackTarget(factory('stack'), ctx([blockerRun()]), inProgress)).toEqual({
      runId: 'blocker-run-id',
      issueNumber: 7,
      branch: 'factory/issue-7-blocker-',
      retargeted: false,
    });
  });

  test('wait mode, two blockers, a blocker with no pull request yet, or one that failed: wait', () => {
    expect(stackTarget(factory('wait'), ctx([blockerRun()]), inProgress)).toBeNull();
    expect(
      stackTarget(factory('stack'), ctx([blockerRun()]), {
        kind: 'blocker-in-progress',
        blockers: [7, 8],
      }),
    ).toBeNull();
    expect(
      stackTarget(factory('stack'), ctx([blockerRun({ prUrl: null })]), inProgress),
    ).toBeNull();
    expect(
      stackTarget(factory('stack'), ctx([blockerRun()]), {
        kind: 'blocker-failed',
        blockers: [7],
      }),
    ).toBeNull();
  });
});

describe('path reservation of a stacked run', () => {
  const triaged = (likelyPaths: string[]) => ({
    decision: 'ready' as const,
    at: '2026-11-23T00:00:00Z',
    contract: { acceptanceCriteria: ['done'], likelyPaths, riskHints: [] },
  });
  const blocker = {
    id: 'blocker-run-id',
    issueNumber: 80,
    state: 'waiting_ci' as const,
    triage: triaged(['src/pad.js', 'src/index.json']),
  };
  const other = { ...blocker, id: 'other-run-id', issueNumber: 90 };
  const stacked = { id: 'stacked-run-id', triage: triaged(['src/table.js', 'src/index.json']) };
  const runsOf = (runs: Array<typeof blocker>) => ({ runs });

  // Found in the E2E: #81, stacked on #80, waited for #80 because both add a module to src/index.json.
  test("is not held by the paths of the run it stacks on, only by another run's", () => {
    expect(pathsHeld(runsOf([blocker]), stacked, { runId: 'blocker-run-id' })).toBeNull();
    expect(pathsHeld(runsOf([blocker]), stacked, null)).toEqual({
      kind: 'paths-overlap',
      blockers: [80],
    });
    expect(pathsHeld(runsOf([blocker, other]), stacked, { runId: 'blocker-run-id' })).toEqual({
      kind: 'paths-overlap',
      blockers: [90],
    });
  });

  // Found in the E2E: triage itself held #87, stacked on #86, for #86's paths.
  test('the paths triage holds a stacked run for leave out the run it stacks on', () => {
    expect(busyPathsOf([blocker, other], stacked.id, 'blocker-run-id')).toEqual([
      { issue: 90, paths: ['src/pad.js', 'src/index.json'] },
    ]);
    expect(busyPathsOf([blocker], stacked.id)).toEqual([
      { issue: 80, paths: ['src/pad.js', 'src/index.json'] },
    ]);
  });
});

describe("a push to the blocker's branch", () => {
  test('integrates the runs stacked on it; the first look only learns the head', async () => {
    const heads = ['a1', 'a1', 'a2'];
    const asked: string[] = [];
    const deps = {
      lastBlockerHead: new Map<string, string>(),
      candidates: async () => [{ runId: 'stacked', blockerPr: 70 }],
      blockerHead: async () => heads.shift() ?? null,
      integrate: async (runId: string) => {
        asked.push(runId);
        return 'integrated' as const;
      },
    };
    await integrateStacked(deps);
    await integrateStacked(deps);
    expect(asked).toEqual([]);
    await integrateStacked(deps);
    expect(asked).toEqual(['stacked']);
  });
});
