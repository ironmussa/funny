import { describe, expect, test } from 'bun:test';

import { classifyCheckCommand } from '../../checks/classify';
import { splitExitCode, summarizeCheckOutput } from '../../checks/summarize';
import { parseTaskProgress } from '../../task-progress';
import { parseTestProgress } from '../../test-progress';

const summarize = (command: string, raw: string) => {
  const check = classifyCheckCommand(command)!;
  const { exitCode, output } = splitExitCode(raw);
  return summarizeCheckOutput(check, output, { exitCode, at: 1000 });
};

describe('summarizeCheckOutput', () => {
  test('a finished vitest run becomes a valid test-progress run', () => {
    const summary = summarize(
      'npx vitest run',
      'Exit code 1\n ❯ src/a.test.ts (3 tests | 1 failed) 5ms\n FAIL  src/a.test.ts > a > breaks\nAssertionError: nope\n ❯ src/a.test.ts:9:3\n      Tests  1 failed | 2 passed (3)',
    );
    expect(summary?.kind).toBe('test');
    const parsed = parseTestProgress(JSON.stringify(summary!.progress));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toMatchObject({
      status: 'failed',
      suites: [
        {
          name: 'vitest',
          status: 'failed',
          passed: 2,
          failed: 1,
          failures: [
            { name: 'a > breaks', file: 'src/a.test.ts', line: 9, message: 'AssertionError: nope' },
          ],
        },
      ],
    });
  });

  test('tsc errors become a valid task-progress run', () => {
    const summary = summarize(
      'bunx tsc --noEmit',
      'Exit code 2\nsrc/a.ts(3,5): error TS2322: Type number is not assignable to type string.',
    );
    expect(summary?.kind).toBe('task');
    const parsed = parseTaskProgress(JSON.stringify(summary!.progress));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toMatchObject({
      title: 'tsc',
      status: 'failed',
      steps: [{ name: 'tsc', status: 'failed', errors: 1 }],
      issues: [{ step: 'tsc', file: 'src/a.ts', line: 3, column: 5 }],
    });
  });

  test('a script names the widget after the script', () => {
    const summary = summarize('bun run lint', 'All checks passed!');
    expect(summary).toMatchObject({ kind: 'task', progress: { title: 'lint', status: 'passed' } });
  });

  test('an empty tsc output with exit code 0 passes', () => {
    const check = classifyCheckCommand('bunx tsc --noEmit')!;
    expect(summarizeCheckOutput(check, '', { exitCode: 0, at: 1 })).toMatchObject({
      kind: 'task',
      progress: { status: 'passed', steps: [{ errors: 0 }] },
    });
  });

  test('a failed step with no issue keeps its output tail', () => {
    const summary = summarize(
      'bun run build',
      'Exit code 1\nBuild failed: 1 module could not be resolved\n  at build.ts',
    );
    expect(summary).toMatchObject({ kind: 'task', progress: { status: 'failed' } });
    if (summary?.kind !== 'task') throw new Error('expected a task');
    expect(summary.progress.steps[0].tail.length).toBeGreaterThan(0);
  });

  test.each([
    ['npx vitest run', ' ✓ src/a.test.ts (5 tests) 120ms'],
    ['bunx tsc --noEmit', 'Generating types…'],
  ])('%s with output that proves nothing → null', (command, output) => {
    expect(summarizeCheckOutput(classifyCheckCommand(command)!, output)).toBeNull();
  });
});

describe('splitExitCode', () => {
  test('reads and drops the Bash tool prefix', () => {
    expect(splitExitCode('Exit code 2\nboom')).toEqual({ exitCode: 2, output: 'boom' });
    expect(splitExitCode('all good')).toEqual({ output: 'all good' });
  });
});
