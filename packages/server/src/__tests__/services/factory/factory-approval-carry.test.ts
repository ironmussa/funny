/**
 * Whether a merge approval of one commit covers another (openspec
 * factory-approval-survives-integration, D3) and asking the runner how the
 * change differs (D2). Seen on 2026-11-24: ten approved runs waited for a
 * person again because a base merge or a small fix made a new commit.
 */
import { describe, expect, test } from 'bun:test';

import { err, ok } from 'neverthrow';

import {
  approvalCovers,
  type ApprovalCoverageInput,
} from '../../../services/factory/factory-approval-carry.js';
import { RUNNER_UNAVAILABLE_PREFIX } from '../../../services/factory/factory-runner-jobs.js';
import {
  changeDeltaOnRunner,
  type ChangeDelta,
  type FactoryStepDeps,
} from '../../../services/factory/factory-step-runner.js';

const delta = (over: Partial<ChangeDelta> = {}): ChangeDelta => ({
  ancestor: true,
  lines: 0,
  files: [],
  filesTruncated: false,
  outsideFrom: [],
  ...over,
});

const seven = delta({ lines: 7, files: [{ path: 'src/a.ts', lines: 7 }] });
const keys = { approvedRiskKeys: ['size', 'sensitive:src/db/migrate.ts'], riskKeys: ['size'] };

describe('approvalCovers', () => {
  const cases: Array<[string, ApprovalCoverageInput, boolean | 'same' | 'adjustment', RegExp?]> = [
    [
      'the same change is covered, with no limit set',
      { delta: delta(), maxAdjustLines: 0 },
      'same',
    ],
    [
      'a delta that is not available is not covered',
      { delta: null, maxAdjustLines: 50 },
      false,
      /could not be compared/,
    ],
    [
      'a head that does not descend from the approved commit is not covered',
      { delta: delta({ ancestor: false }), maxAdjustLines: 50 },
      false,
      /no longer contains/,
    ],
    [
      'a difference is not covered while the factory sets no limit',
      { delta: seven, maxAdjustLines: 0, ...keys },
      false,
      /differs from the approved commit by 7 lines/,
    ],
    [
      'a difference within the limit is an adjustment',
      { delta: seven, maxAdjustLines: 50, ...keys },
      'adjustment',
    ],
    [
      'a difference of exactly the limit is covered',
      { delta: seven, maxAdjustLines: 7, ...keys },
      'adjustment',
    ],
    [
      'a difference over the limit is not covered',
      {
        delta: delta({ lines: 852, files: [{ path: 'src/a.ts', lines: 852 }] }),
        maxAdjustLines: 50,
        ...keys,
      },
      false,
      /852 lines; this factory follows 50/,
    ],
    [
      'a file the approved change did not touch is not covered',
      { delta: { ...seven, outsideFrom: ['src/new.ts'] }, maxAdjustLines: 50, ...keys },
      false,
      /src\/new\.ts/,
    ],
    [
      'a list of files cut short is not covered',
      { delta: { ...seven, filesTruncated: true }, maxAdjustLines: 50, ...keys },
      false,
      /too many files/,
    ],
    [
      'a risk reason the approved commit did not have is not covered',
      {
        delta: seven,
        maxAdjustLines: 50,
        approvedRiskKeys: ['size'],
        riskKeys: ['size', 'finding:skip-marker:src/a.test.ts'],
      },
      false,
      /finding:skip-marker:src\/a\.test\.ts/,
    ],
    [
      'an approval recorded without risk keys follows only the same change',
      { delta: seven, maxAdjustLines: 50, riskKeys: ['size'] },
      false,
      /were not recorded/,
    ],
  ];

  for (const [name, input, expected, reason] of cases) {
    test(name, () => {
      const coverage = approvalCovers(input);
      if (expected === false) {
        expect(coverage.covers).toBe(false);
        expect(coverage.covers ? '' : coverage.reason).toMatch(reason!);
      } else {
        expect(coverage).toMatchObject({ covers: true, kind: expected });
      }
    });
  }

  test('an adjustment names its lines and files', () => {
    expect(approvalCovers({ delta: seven, maxAdjustLines: 50, ...keys })).toEqual({
      covers: true,
      kind: 'adjustment',
      lines: 7,
      files: ['src/a.ts'],
    });
  });
});

describe('asking the runner for the delta', () => {
  const commits = { from: 'a'.repeat(40), to: 'b'.repeat(40), baseBranch: 'main', branch: 'f/1' };
  const signal = new AbortController().signal;
  const answering = (result: unknown): FactoryStepDeps => ({
    startStep: async () => ok({ stepId: 's1', state: 'running' }),
    pollStep: async () => ok({ state: 'done', result }),
    pollMs: 1,
  });

  test('a comparison is returned as the delta', async () => {
    const result = { kind: 'change-delta', outcome: 'compared', ...seven, message: '' };
    const asked = await changeDeltaOnRunner(answering(result), 't1', commits, signal);
    expect(asked._unsafeUnwrap()).toEqual(seven);
  });

  test('the step is asked of the thread it is given, with both commits', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    const steps = answering({ kind: 'change-delta', outcome: 'compared', ...delta(), message: '' });
    await changeDeltaOnRunner(
      {
        ...steps,
        startStep: async (threadId, body) => {
          started.push([threadId, body]);
          return ok({ stepId: 's1', state: 'running' });
        },
      },
      't1',
      commits,
      signal,
    );
    expect(started).toMatchObject([['t1', { kind: 'change-delta', ...commits }]]);
  });

  // The run's own runner is the only one asked: an offline runner means no answer.
  test('an offline runner gives no delta', async () => {
    let starts = 0;
    const asked = await changeDeltaOnRunner(
      {
        startStep: async () => {
          starts += 1;
          return err(`${RUNNER_UNAVAILABLE_PREFIX} the runner is offline`);
        },
        pollStep: async () => err('step-not-found'),
        pollMs: 1,
      },
      't1',
      commits,
      signal,
    );
    expect(asked.isErr()).toBe(true);
    expect(starts).toBe(1);
  });

  // A runner from before this step refuses the request body.
  test('a runner that does not know the step gives no delta', async () => {
    const asked = await changeDeltaOnRunner(
      {
        startStep: async () => err('Invalid input'),
        pollStep: async () => err('step-not-found'),
        pollMs: 1,
      },
      't1',
      commits,
      signal,
    );
    expect(asked._unsafeUnwrapErr()).toContain('Invalid input');
  });

  test('a comparison the runner could not make gives no delta', async () => {
    const failed = {
      kind: 'change-delta',
      outcome: 'failed',
      ...delta({ ancestor: false }),
      message: 'Commit bbbb is not in this checkout.',
    };
    const asked = await changeDeltaOnRunner(answering(failed), 't1', commits, signal);
    expect(asked._unsafeUnwrapErr()).toContain('not in this checkout');
  });

  test('another step answering gives no delta', async () => {
    const other = {
      kind: 'command',
      outcome: 'passed',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    };
    const asked = await changeDeltaOnRunner(answering(other), 't1', commits, signal);
    expect(asked.isErr()).toBe(true);
  });
});
