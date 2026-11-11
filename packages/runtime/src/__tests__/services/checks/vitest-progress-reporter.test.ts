import { join } from 'node:path';

import { createOutputParser, TEST_EVENT_PREFIX } from '@funny/shared/checks';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ProgressReporter, {
  TEST_EVENT_PREFIX as REPORTER_PREFIX,
} from '../../../services/checks/vitest-progress-reporter.mjs';

const file = join(process.cwd(), 'src/a.test.ts');

/** What the reporter wrote to stdout, as lines. */
function capture(run: (reporter: ProgressReporter) => void): string[] {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    run(new ProgressReporter());
  } finally {
    write.mockRestore();
  }
  return chunks.join('').trimEnd().split('\n');
}

const testCase = (state: string, errors?: unknown[]) => ({
  module: { moduleId: file },
  fullName: 'a > works',
  result: () => ({ state, errors }),
  diagnostic: () => ({ duration: 12 }),
});

afterEach(() => vi.restoreAllMocks());

describe('vitest progress reporter', () => {
  test('prints the shared event prefix', () => {
    expect(REPORTER_PREFIX).toBe(TEST_EVENT_PREFIX);
  });

  test('its events drive the shared parser: run, file, tests and file end', () => {
    const lines = capture((reporter) => {
      reporter.onTestRunStart([{ moduleId: file }, { moduleId: file }]);
      reporter.onTestModuleQueued({ moduleId: file });
      reporter.onTestCaseResult(testCase('passed'));
      reporter.onTestCaseResult(testCase('pending'));
      reporter.onTestModuleEnd({ moduleId: file, diagnostic: () => ({ duration: 40 }) });
    });
    const parse = createOutputParser(() => 0);
    const counts = lines.map(parse).at(-1);
    expect(counts).toMatchObject({
      passed: 1,
      skipped: 1,
      filesTotal: 1,
      filesDone: 1,
      running: [],
    });
  });

  test('a failed test carries its first error and the line in its own file', () => {
    const [line] = capture((reporter) =>
      reporter.onTestCaseResult(
        testCase('failed', [
          {
            message: 'expected 1 to be 2\n\n- 2\n+ 1',
            stacks: [
              { file: '/elsewhere/helper.ts', line: 3 },
              { file, line: 9 },
            ],
          },
        ]),
      ),
    );
    expect(JSON.parse(line.slice(TEST_EVENT_PREFIX.length))).toEqual({
      e: 'test',
      file: 'src/a.test.ts',
      name: 'a > works',
      state: 'failed',
      ms: 12,
      error: { message: 'expected 1 to be 2', line: 9 },
    });
  });

  test('a failure without errors still says it failed', () => {
    const [line] = capture((reporter) => reporter.onTestCaseResult(testCase('failed')));
    expect(line).toContain('"error":{"message":"failed"}');
  });
});
