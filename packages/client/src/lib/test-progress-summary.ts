import {
  SLOW_TEST_MS,
  type TestProgress,
  type TestProgressSuite,
} from '@funny/shared/test-progress';

/** A slow file or test, finished or still running. */
export interface SlowItem {
  suite: string;
  kind: 'file' | 'test';
  name: string;
  durationMs: number;
  /** Still running: `durationMs` is the time so far. */
  running: boolean;
}

export interface TestProgressSummary {
  passed: number;
  failed: number;
  skipped: number;
  suitesDone: number;
  suitesRunning: number;
  /** 0–100, by test files where the runner reports them, else by suite. */
  percent: number;
  /** Slowest first, at most `SLOW_ITEMS`. */
  slow: SlowItem[];
}

/** Slow items listed in the widget. */
export const SLOW_ITEMS = 10;

const isFinished = (suite: TestProgressSuite) =>
  suite.status === 'passed' || suite.status === 'failed';

/**
 * A suite's share of the bar, in test files: `[done, total]`. A suite whose
 * runner does not report files (bun, cargo) counts as one file, done when it ends.
 */
function fileUnits(suite: TestProgressSuite): [number, number] {
  const total = suite.filesTotal || 1;
  if (isFinished(suite)) return [total, total];
  return [Math.min(suite.filesDone ?? 0, total), total];
}

function slowItems(suites: readonly TestProgressSuite[], now: number): SlowItem[] {
  const finished = suites.flatMap((suite) =>
    suite.slow.map((entry) => ({ suite: suite.name, ...entry, running: false })),
  );
  const running = suites.flatMap((suite) =>
    suite.running
      .map((run) => ({
        suite: suite.name,
        kind: 'file' as const,
        name: run.file,
        durationMs: now - run.startedAt,
        running: true,
      }))
      .filter((item) => item.durationMs >= SLOW_TEST_MS),
  );
  return [...running, ...finished].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOW_ITEMS);
}

/** Totals, progress and the slow list of a run, as of `now`. */
export function summarizeTestProgress(progress: TestProgress, now: number): TestProgressSummary {
  const { suites } = progress;
  let [doneUnits, totalUnits] = [0, 0];
  for (const suite of suites) {
    const [done, total] = fileUnits(suite);
    doneUnits += done;
    totalUnits += total;
  }
  return {
    passed: suites.reduce((sum, suite) => sum + suite.passed, 0),
    failed: suites.reduce((sum, suite) => sum + suite.failed, 0),
    skipped: suites.reduce((sum, suite) => sum + suite.skipped, 0),
    suitesDone: suites.filter(isFinished).length,
    suitesRunning: suites.filter((suite) => suite.status === 'running').length,
    percent: totalUnits === 0 ? 0 : (doneUnits / totalUnits) * 100,
    slow: slowItems(suites, now),
  };
}
