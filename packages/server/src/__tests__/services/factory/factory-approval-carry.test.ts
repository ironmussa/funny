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
  approvalGapOf,
  approvalMoveComment,
  approvalMoveTitle,
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
      baseFiles: [],
    });
  });
});

// openspec factory-approval-follows-base-code: what lost #450, #458 and #478 on 2026-11-25.
describe('approvalCovers and the code the base brought', () => {
  const fixedBase = delta({
    lines: 9,
    files: [
      { path: 'src/a.ts', lines: 7 },
      { path: 'src/new.ts', lines: 2 },
    ],
    outsideFrom: ['src/new.ts'],
    baseBrought: ['src/new.ts'],
    linesAcrossMoves: 9,
  });

  test('a fix of a file the base brought is an adjustment that names the file', () => {
    expect(approvalCovers({ delta: fixedBase, maxAdjustLines: 50, ...keys })).toEqual({
      covers: true,
      kind: 'adjustment',
      lines: 9,
      files: ['src/a.ts', 'src/new.ts'],
      baseFiles: ['src/new.ts'],
    });
  });

  test('a file outside the approved change that the base did not bring is still refused', () => {
    const coverage = approvalCovers({
      delta: { ...fixedBase, outsideFrom: ['src/new.ts', 'src/elsewhere.ts'] },
      maxAdjustLines: 50,
      ...keys,
    });
    expect(coverage.covers ? '' : coverage.reason).toMatch(/src\/elsewhere\.ts.*did not bring/);
  });

  test('the limit counts the edits that moved with their code once', () => {
    // #478: 175 lines file by file, 99 without the edits a split moved.
    const moved = { ...fixedBase, lines: 175, linesAcrossMoves: 99 };
    expect(approvalCovers({ delta: moved, maxAdjustLines: 100, ...keys })).toMatchObject({
      covers: true,
      lines: 99,
    });
    const refused = approvalCovers({ delta: moved, maxAdjustLines: 90, ...keys });
    expect(refused.covers ? '' : refused.reason).toMatch(/99 lines; this factory follows 90/);
  });

  test('a change that is the same only across moves is an adjustment, not the same change', () => {
    const coverage = approvalCovers({
      delta: { ...fixedBase, lines: 4, linesAcrossMoves: 0 },
      maxAdjustLines: 50,
      ...keys,
    });
    expect(coverage).toMatchObject({ covers: true, kind: 'adjustment', lines: 0 });
  });

  test('a sensitive path the base brought is a new risk reason', () => {
    const coverage = approvalCovers({
      delta: fixedBase,
      maxAdjustLines: 50,
      approvedRiskKeys: ['size'],
      riskKeys: ['size', 'sensitive:src/new.ts'],
    });
    expect(coverage.covers ? '' : coverage.reason).toMatch(/sensitive:src\/new\.ts/);
  });

  test('a runner that does not say what the base brought leaves the file-by-file rule', () => {
    const { baseBrought: _b, linesAcrossMoves: _l, ...old } = fixedBase;
    const coverage = approvalCovers({ delta: old, maxAdjustLines: 50, ...keys });
    expect(coverage.covers ? '' : coverage.reason).toMatch(/src\/new\.ts/);
  });

  test('the gap tells the files the base brought from the others', () => {
    const gap = approvalGapOf(
      { delta: { ...fixedBase, outsideFrom: ['src/new.ts', 'src/x.ts'] }, maxAdjustLines: 5 },
      'b'.repeat(40),
      'over the limit',
      '2026-11-25T00:00:00.000Z',
    );
    expect(gap).toMatchObject({ lines: 9, newFiles: ['src/new.ts'], baseFiles: ['src/new.ts'] });
  });
});

describe('what a moved approval says', () => {
  const move = { userId: 'alice', from: 'a'.repeat(40), to: 'b'.repeat(40) };

  test('the same change: both commits, and that nobody approved the new one', () => {
    const body = approvalMoveComment({ ...move, kind: 'same', lines: 0, files: [], baseFiles: [] });
    expect(body).toContain('aaaaaaa');
    expect(body).toContain('bbbbbbb');
    expect(body).toContain('the same lines at both commits');
    expect(body).toContain('This comment is automated: no person approved the new commit');
  });

  test('an adjustment: its lines and its files, the list cut after twenty', () => {
    const files = Array.from({ length: 23 }, (_, i) => `src/f${i}.ts`);
    const body = approvalMoveComment({
      ...move,
      kind: 'adjustment',
      lines: 7,
      files,
      baseFiles: [],
    });
    expect(body).toContain('differs from the approved one by 7 lines');
    expect(body).toContain('- `src/f0.ts`');
    expect(body).toContain('- … and 3 more');
    expect(body).not.toContain('src/f22.ts');
    expect(body).toContain('no person approved the new commit');
  });

  test('an adjustment into code the base brought lists those files apart', () => {
    const body = approvalMoveComment({
      ...move,
      kind: 'adjustment',
      lines: 9,
      files: ['src/a.ts', 'src/new.ts'],
      baseFiles: ['src/new.ts'],
    });
    expect(body).toContain('In files the approved change already touched:\n- `src/a.ts`');
    expect(body).toContain('which the change now also fixes:\n- `src/new.ts`');
  });

  test('the activity title names the issue and what differs', () => {
    expect(
      approvalMoveTitle({ ...move, kind: 'same', lines: 0, files: [], baseFiles: [] }, 451),
    ).toBe('Merge approval of #451 moved from aaaaaaa to bbbbbbb (same change)');
    expect(
      approvalMoveTitle(
        { ...move, kind: 'adjustment', lines: 1, files: ['a'], baseFiles: [] },
        null,
      ),
    ).toBe('Merge approval moved from aaaaaaa to bbbbbbb (1 line differs)');
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

// openspec factory-merge-fewer-bounces, D2: what the member is shown when asked again.
describe('approvalGapOf', () => {
  const at = '2026-11-25T00:00:00.000Z';

  // #480: 8 lines in a file the approved change did not touch.
  test('a file the approval did not cover is listed as new', () => {
    const input = {
      delta: delta({
        lines: 8,
        files: [{ path: 'src/ports/factory.ts', lines: 8 }],
        outsideFrom: ['src/ports/factory.ts'],
      }),
      maxAdjustLines: 30,
      ...keys,
    };
    expect(approvalGapOf(input, 'b'.repeat(40), 'the change now touches it', at)).toEqual({
      to: 'b'.repeat(40),
      at,
      lines: 8,
      files: ['src/ports/factory.ts'],
      moreFiles: 0,
      newFiles: ['src/ports/factory.ts'],
      baseFiles: [],
      newRiskKeys: [],
      reason: 'the change now touches it',
    });
  });

  test('the risk reasons the approved commit did not have are named', () => {
    const gap = approvalGapOf(
      { delta: seven, maxAdjustLines: 30, approvedRiskKeys: ['size'], riskKeys: ['size', 'ci'] },
      'b'.repeat(40),
      'a new risk reason',
      at,
    );
    expect(gap).toMatchObject({ lines: 7, newFiles: [], newRiskKeys: ['ci'] });
  });

  test('more than 20 files are counted, not listed', () => {
    const files = Array.from({ length: 23 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
    const gap = approvalGapOf(
      { delta: delta({ lines: 23, files }), maxAdjustLines: 30 },
      'b'.repeat(40),
      'too many',
      at,
    );
    expect(gap.files).toHaveLength(20);
    expect(gap.moreFiles).toBe(3);
  });

  test('a change that could not be compared has no line count', () => {
    const unavailable = approvalGapOf({ delta: null, maxAdjustLines: 30 }, 'b'.repeat(40), 'x', at);
    expect(unavailable).toMatchObject({ lines: null, files: [], newFiles: [] });
    const rewritten = approvalGapOf(
      { delta: delta({ ancestor: false }), maxAdjustLines: 30 },
      'b'.repeat(40),
      'x',
      at,
    );
    expect(rewritten.lines).toBeNull();
  });
});
