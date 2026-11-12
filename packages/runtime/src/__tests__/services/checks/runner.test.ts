import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEST_EVENT_PREFIX } from '@funny/shared/checks';
import { parseTaskProgress } from '@funny/shared/task-progress';
import { parseTestProgress } from '@funny/shared/test-progress';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  checkEnv,
  runCheck,
  VITEST_REPORTER,
  withVitestReporter,
} from '../../../services/checks/runner.js';
import { summarizeCheckRun } from '../../../services/checks/summary.js';
import type { CheckPlan } from '../../../services/checks/toolchain.js';

let dir: string;
let progressPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-check-run-'));
  progressPath = join(dir, 'progress.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A plan whose steps print `outputs` (via printf) and exit with `codes`. */
function plan(
  kind: CheckPlan['kind'],
  steps: { output: string; code?: number; name?: string }[],
  extra: Partial<CheckPlan> = {},
): CheckPlan {
  return {
    kind,
    cwd: dir,
    progress: kind === 'test' ? 'test' : 'task',
    notes: [],
    steps: steps.map(({ output, code = 0, name = kind }, index) => {
      const file = join(dir, `out-${index}.txt`);
      writeFileSync(file, output);
      return { name, command: `cat '${file}'; exit ${code}`, tool: 'unknown' };
    }),
    ...extra,
  };
}

const readTest = () => {
  const parsed = parseTestProgress(readFileSync(progressPath, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const readTask = () => {
  const parsed = parseTaskProgress(readFileSync(progressPath, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe('runCheck', () => {
  test('a failing test run ends failed with its failures, in the file and the summary', async () => {
    const run = plan('test', [
      {
        name: 'vitest',
        code: 1,
        output: [
          ' ❯ src/a.test.ts (3 tests | 1 failed) 5ms',
          ' FAIL  src/a.test.ts > a > breaks',
          'AssertionError: expected 1 to be 2',
          ' ❯ src/a.test.ts:9:3',
          '      Tests  1 failed | 2 passed (3)',
        ].join('\n'),
      },
    ]);
    const result = await runCheck(run, { progressPath });
    expect(result.exitCode).toBe(1);
    expect(readTest()).toMatchObject({
      status: 'failed',
      suites: [
        { status: 'failed', passed: 2, failed: 1, failures: [{ name: 'a > breaks', line: 9 }] },
      ],
    });
    const summary = summarizeCheckRun(run, result, progressPath);
    expect(summary).toContain('test FAILED (exit 1');
    expect(summary).toContain('Tests: 2 passed, 1 failed, 0 skipped');
    expect(summary).toContain('✗ src/a.test.ts:9 a > breaks — AssertionError: expected 1 to be 2');
    expect(summary).not.toContain('Output tail');
    expect(summary).toContain(`progressPath: ${progressPath}`);
  });

  test('reporter event lines count tests and stay out of the tail', async () => {
    const event = (body: object) => `${TEST_EVENT_PREFIX}${JSON.stringify(body)}`;
    const run = plan('test', [
      {
        output: [
          event({ e: 'run', files: 1 }),
          event({ e: 'file', file: 'a.test.ts' }),
          event({ e: 'test', file: 'a.test.ts', name: 'works', state: 'passed', ms: 1 }),
          event({ e: 'file-end', file: 'a.test.ts', ms: 2 }),
          '      Tests  1 passed (1)',
        ].join('\n'),
      },
    ]);
    const result = await runCheck(run, { progressPath });
    expect(readTest().suites[0]).toMatchObject({ status: 'passed', passed: 1, filesDone: 1 });
    expect(result.tail.some((line) => line.includes(TEST_EVENT_PREFIX))).toBe(false);
  });

  test('task steps run in order and report errors per step', async () => {
    const run = plan('verify', [
      { name: 'lint', output: 'All checks passed!' },
      {
        name: 'typecheck',
        code: 2,
        output: 'src/a.ts(3,5): error TS2322: Type number is not assignable.',
      },
    ]);
    const result = await runCheck(run, { progressPath });
    expect(result.exitCode).toBe(2);
    expect(readTask()).toMatchObject({
      status: 'failed',
      steps: [
        { name: 'lint', status: 'passed', errors: 0 },
        { name: 'typecheck', status: 'failed', errors: 1 },
      ],
      issues: [{ step: 'typecheck', file: 'src/a.ts', line: 3, column: 5 }],
    });
    const summary = summarizeCheckRun(run, result, progressPath);
    expect(summary).toContain('✗ typecheck: 1 errors, 0 warnings');
    expect(summary).toContain('error src/a.ts:3:5 TS2322');
  });

  test('a failure without issues keeps the output tail', async () => {
    const run = plan('build', [{ code: 1, output: 'Something broke\nfor good' }]);
    const result = await runCheck(run, { progressPath });
    expect(readTask().steps[0].tail).toEqual(['Something broke', 'for good']);
    expect(summarizeCheckRun(run, result, progressPath)).toContain(
      'Output tail:\n  Something broke\n  for good',
    );
  });

  test('cancelling mid-run kills the process and ends the file failed', async () => {
    const run: CheckPlan = {
      kind: 'test',
      cwd: dir,
      progress: 'test',
      notes: [],
      steps: [
        {
          name: 'slow',
          command: `echo started; sleep 30; echo late > '${join(dir, 'late')}'`,
          tool: 'unknown',
        },
      ],
    };
    const controller = new AbortController();
    const pending = runCheck(run, { progressPath, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await pending;
    expect(result.stopped).toBe('cancelled');
    expect(readTest().status).toBe('failed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(dir, 'late'))).toBe(false);
  });

  test('a timeout stops the run and suggests a background run', async () => {
    const run: CheckPlan = {
      kind: 'lint',
      cwd: dir,
      progress: 'task',
      notes: [],
      steps: [{ name: 'lint', command: 'sleep 30', tool: 'unknown' }],
    };
    const result = await runCheck(run, { progressPath, timeoutMs: 200 });
    expect(result.stopped).toBe('timeout');
    expect(readTask().status).toBe('failed');
    expect(summarizeCheckRun(run, result, progressPath)).toContain('background: true');
  });

  test('a self-reporting command writes the file; a run it left running ends failed', async () => {
    const run: CheckPlan = {
      kind: 'test',
      cwd: dir,
      progress: 'test',
      notes: [],
      progressEnv: 'FUNNY_TEST_PROGRESS',
      steps: [
        {
          name: 'test',
          command: `printf '%s' '{"version":1,"status":"running","startedAt":1,"updatedAt":1,"suites":[]}' > "$FUNNY_TEST_PROGRESS"; exit 1`,
          tool: 'script',
        },
      ],
    };
    const result = await runCheck(run, { progressPath });
    expect(result.progress.progress.status).toBe('failed');
    expect(readTest()).toMatchObject({ status: 'failed', startedAt: 1 });
  });
});

describe('withVitestReporter', () => {
  test('adds the reporter to a direct call and after -- for a script', () => {
    expect(withVitestReporter('npx vitest run')).toBe(
      `npx vitest run --reporter=default --reporter=${VITEST_REPORTER}`,
    );
    expect(withVitestReporter('npm run test')).toBe(
      `npm run test -- --reporter=default --reporter=${VITEST_REPORTER}`,
    );
    expect(withVitestReporter('npm run test -- src')).toBe(
      `npm run test -- src --reporter=default --reporter=${VITEST_REPORTER}`,
    );
  });

  test('the bundled reporter exists and prints the shared event prefix', async () => {
    expect(existsSync(VITEST_REPORTER)).toBe(true);
    const reporter = await import(VITEST_REPORTER);
    expect(reporter.TEST_EVENT_PREFIX).toBe(TEST_EVENT_PREFIX);
  });
});

describe('checkEnv', () => {
  test('drops the agent markers that make bun and vitest hide the tests that ran', () => {
    const saved = {
      CLAUDECODE: process.env.CLAUDECODE,
      AGENT: process.env.AGENT,
      AI_AGENT: process.env.AI_AGENT,
    };
    process.env.CLAUDECODE = '1';
    process.env.AGENT = '1';
    process.env.AI_AGENT = 'claude';
    try {
      const env = checkEnv({ EXTRA: 'x' });
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.AGENT).toBeUndefined();
      expect(env.AI_AGENT).toBeUndefined();
      expect(env).toMatchObject({ EXTRA: 'x', CI: '1', FORCE_COLOR: '0' });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
