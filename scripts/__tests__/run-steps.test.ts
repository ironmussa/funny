import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStepParser } from '../../packages/shared/src/checks';
import { parseTaskProgress } from '../../packages/shared/src/task-progress';
import { runTask } from '../run-steps';
import { stepsOf, taskFor } from '../task-steps';

describe('task steps', () => {
  const scripts = {
    lint: 'oxlint . && bun run fitness:layering && bun run --cwd packages/remote-connector lint',
    typecheck: 'bun scripts/fitness/check-typecheck.ts && bun run typecheck:proofs',
    build: 'bun run --cwd packages/client build && bun run --cwd packages/server build',
  };

  test('each `&&` part of a script is a step, labelled by its script name', () => {
    expect(stepsOf(scripts.lint)).toEqual([
      { id: 'oxlint .', name: 'oxlint .' },
      { id: 'bun run fitness:layering', name: 'fitness:layering' },
      { id: 'bun run --cwd packages/remote-connector lint', name: 'remote-connector:lint' },
    ]);
  });

  test('build runs in order; lint and typecheck may run side by side', () => {
    expect(taskFor('build', scripts)?.sequential).toBe(true);
    expect(taskFor('lint', scripts)?.sequential).toBe(false);
  });

  test('verify is lint, typecheck and the test runner', () => {
    expect(taskFor('verify', scripts)?.steps.map((step) => step.name)).toEqual([
      'oxlint .',
      'fitness:layering',
      'remote-connector:lint',
      'check-typecheck',
      'typecheck:proofs',
      'run-tests',
    ]);
  });

  test('an unknown task, or one whose script is missing, is null', () => {
    expect(taskFor('deploy', scripts)).toBeNull();
    expect(taskFor('lint', {})).toBeNull();
    expect(taskFor('verify', { lint: 'oxlint .' })).toBeNull();
  });
});

const feed = (lines: string[]) => {
  const parse = createStepParser('step');
  const issues = lines.flatMap((line) => parse(line).issues);
  return { report: parse('').report, issues };
};

describe('createStepParser', () => {
  test('oxlint issues', () => {
    const { report, issues } = feed([
      "src/a.ts:3:7: warning eslint(no-unused-vars): Variable 'x' is declared but never used.",
      'src/b.ts:10:1: error eslint(no-debugger): Unexpected debugger statement.',
    ]);
    expect(report).toMatchObject({ errors: 1, warnings: 1 });
    expect(issues[1]).toEqual({
      step: 'step',
      severity: 'error',
      file: 'src/b.ts',
      line: 10,
      column: 1,
      message: 'eslint(no-debugger): Unexpected debugger statement.',
    });
  });

  test('tsc issues', () => {
    const { issues } = feed([
      "packages/x/src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
    expect(issues[0]).toMatchObject({ file: 'packages/x/src/a.ts', line: 12, column: 5 });
    expect(issues[0].message).toStartWith('TS2322:');
  });

  test('cargo issues take the location from the next line, summaries are not issues', () => {
    const { report, issues } = feed([
      'error[E0425]: cannot find value `x` in this scope',
      '  --> src/main.rs:4:13',
      'warning: unused import',
      'error: could not compile `remote-connector` (bin) due to 1 previous error',
    ]);
    expect(report).toMatchObject({ errors: 1, warnings: 1 });
    expect(issues[0]).toMatchObject({ file: 'src/main.rs', line: 4, column: 13 });
    expect(issues[1]).toMatchObject({ severity: 'warning', message: 'unused import' });
    expect(issues[1].file).toBeUndefined();
  });

  test('typecheck projects advance the units', () => {
    const { report } = feed([
      'Running bun check against 3 projects…',
      '  packages/client/tsconfig.json… 0 error(s)',
      '  packages/server/tsconfig.json… 0 error(s)',
    ]);
    expect(report).toMatchObject({
      unitsTotal: 3,
      unitsDone: 2,
      current: 'packages/server/tsconfig.json',
    });
  });

  test('test runner suites advance the units; a failed suite is an error', () => {
    const { report } = feed(['▶ @x/a', '✓ @x/a 1.2s', '▶ @x/b', '✗ @x/b 3.4s']);
    expect(report).toMatchObject({ unitsDone: 2, errors: 1, current: '@x/b' });
  });

  test('a check’s own ✓ line is its current line, not a suite', () => {
    const { report } = feed(['✓ No new typecheck errors (baseline: 116, current: 0)']);
    expect(report.unitsDone).toBeUndefined();
    expect(report.current).toBe('✓ No new typecheck errors (baseline: 116, current: 0)');
  });

  test('keeps the last lines as the tail', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    expect(feed(lines).report.tail).toEqual(lines.slice(-8));
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-steps-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runTask', () => {
  test('runs every step, records progress and issues, fails when one fails', async () => {
    const path = join(dir, 'progress.json');
    const task = {
      name: 'lint',
      sequential: false,
      steps: [
        { id: `printf 'src/a.ts:1:2: warning rule: careful\\n'`, name: 'warns' },
        { id: `printf 'src/b.ts:3:4: error rule: broken\\n'; exit 1`, name: 'breaks' },
        { id: `printf 'something odd happened\\n'; exit 2`, name: 'crashes' },
      ],
    };

    expect(await runTask(task, { root: dir, concurrency: 2, progressPath: path })).toBe(1);
    const parsed = parseTaskProgress(readFileSync(path, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    const progress = parsed.value;
    expect(progress).toMatchObject({ title: 'lint', status: 'failed', concurrency: 2 });
    expect(progress.steps.map((step) => [step.name, step.status])).toEqual([
      ['warns', 'passed'],
      ['breaks', 'failed'],
      ['crashes', 'failed'],
    ]);
    // Errors first; the tail is kept only for the step without issues of its own.
    expect(progress.issues.map((issue) => issue.severity)).toEqual(['error', 'warning']);
    expect(progress.steps[1].tail).toEqual([]);
    expect(progress.steps[2].tail).toEqual(['something odd happened']);
  });

  test('a sequential task runs one step at a time', async () => {
    const log = join(dir, 'order');
    const step = (name: string) => ({
      id: `echo start-${name} >> '${log}'; sleep 0.2; echo end-${name} >> '${log}'`,
      name,
    });
    const task = { name: 'build', sequential: true, steps: [step('a'), step('b')] };

    expect(await runTask(task, { root: dir, concurrency: 4 })).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'start-a',
      'end-a',
      'start-b',
      'end-b',
    ]);
  });
});
