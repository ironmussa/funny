import type { TestProgress, TestProgressSuite } from '@funny/shared/test-progress';
import { describe, expect, test } from 'vitest';

import { SLOW_ITEMS, summarizeTestProgress } from '@/lib/test-progress-summary';

function suite(fields: Partial<TestProgressSuite> & { name: string }): TestProgressSuite {
  return {
    status: 'queued',
    related: false,
    passed: 0,
    failed: 0,
    skipped: 0,
    running: [],
    slow: [],
    ...fields,
  };
}

const run = (suites: TestProgressSuite[]): TestProgress => ({
  version: 1,
  status: 'running',
  startedAt: 0,
  updatedAt: 0,
  suites,
});

describe('summarizeTestProgress', () => {
  test('adds up the counts and the finished and running suites', () => {
    const summary = summarizeTestProgress(
      run([
        suite({ name: 'a', status: 'passed', passed: 10, skipped: 1 }),
        suite({ name: 'b', status: 'failed', passed: 5, failed: 2 }),
        suite({ name: 'c', status: 'running', passed: 3 }),
        suite({ name: 'd' }),
      ]),
      0,
    );
    expect(summary).toMatchObject({
      passed: 18,
      failed: 2,
      skipped: 1,
      suitesDone: 2,
      suitesRunning: 1,
    });
  });

  test('progress counts test files where reported and one unit per other suite', () => {
    // a: 1 unit, done. b: 30 of 100 files. c: 1 unit, queued. → 31 / 102.
    const summary = summarizeTestProgress(
      run([
        suite({ name: 'a', status: 'passed' }),
        suite({ name: 'b', status: 'running', filesTotal: 100, filesDone: 30 }),
        suite({ name: 'c' }),
      ]),
      0,
    );
    expect(summary.percent).toBeCloseTo((31 / 102) * 100);
  });

  test('a finished suite counts all its files, even if fewer were reported', () => {
    const summary = summarizeTestProgress(
      run([suite({ name: 'a', status: 'failed', filesTotal: 10, filesDone: 4 })]),
      0,
    );
    expect(summary.percent).toBe(100);
  });

  test('lists slow finished entries and files running for 10 s or more, slowest first', () => {
    const summary = summarizeTestProgress(
      run([
        suite({
          name: 'web',
          status: 'running',
          running: [
            { file: 'stuck.test.ts', startedAt: 1_000 },
            { file: 'fresh.test.ts', startedAt: 20_000 },
          ],
          slow: [{ kind: 'test', name: 'a.test.ts › slow', durationMs: 11_000 }],
        }),
      ]),
      25_000,
    );
    expect(summary.slow).toEqual([
      { suite: 'web', kind: 'file', name: 'stuck.test.ts', durationMs: 24_000, running: true },
      { suite: 'web', kind: 'test', name: 'a.test.ts › slow', durationMs: 11_000, running: false },
    ]);
  });

  test(`keeps at most ${SLOW_ITEMS} slow entries`, () => {
    const slow = Array.from({ length: SLOW_ITEMS + 5 }, (_, i) => ({
      kind: 'file' as const,
      name: `f${i}.test.ts`,
      durationMs: 10_000 + i,
    }));
    const summary = summarizeTestProgress(run([suite({ name: 'a', slow })]), 0);
    expect(summary.slow).toHaveLength(SLOW_ITEMS);
    expect(summary.slow[0].name).toBe(`f${SLOW_ITEMS + 4}.test.ts`);
  });
});
