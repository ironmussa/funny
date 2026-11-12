// Live test progress for the client's `test-progress` visualizer.
//
// `run-tests.ts` feeds each suite's output, line by line, to the parser in
// `@funny/shared/checks` (vitest suites also get the runtime's `vitest-progress-reporter.mjs`,
// whose event lines give per-test progress, the files running and the slow
// ones), and a `ProgressFile` rewrites the JSON file `FUNNY_TEST_PROGRESS`
// names (atomically, at most every `intervalMs`). The shape is `TestProgress` in
// `@funny/shared/test-progress`.

import { suiteFields, type SuiteCounts } from '../packages/shared/src/checks';
import {
  openProgressFile,
  type ThrottledJsonFile,
  type ThrottleOptions,
} from '../packages/shared/src/checks/progress-file';
import {
  TEST_PROGRESS_VERSION,
  type TestProgress,
  type TestProgressSuite,
} from '../packages/shared/src/test-progress';

interface ProgressFileOptions extends ThrottleOptions {
  /** Suites the runner runs at once. */
  concurrency?: number;
}

function queuedSuite({ name, related }: { name: string; related: boolean }): TestProgressSuite {
  return {
    name,
    related,
    status: 'queued',
    passed: 0,
    failed: 0,
    skipped: 0,
    running: [],
    slow: [],
    failures: [],
    files: [],
  };
}

/** Rewrites the progress file as suites start, report and finish. */
export class ProgressFile {
  private readonly file: ThrottledJsonFile<TestProgress>;

  constructor(
    path: string,
    suites: readonly { name: string; related: boolean }[],
    options: ProgressFileOptions = {},
  ) {
    this.file = openProgressFile<TestProgress>(
      path,
      (head) => ({ version: TEST_PROGRESS_VERSION, ...head, suites: suites.map(queuedSuite) }),
      options,
    );
  }

  start(index: number): void {
    this.patch(index, { status: 'running', startedAt: this.file.now() });
  }

  report(index: number, counts: SuiteCounts): void {
    this.patch(index, suiteFields(counts));
  }

  finish(index: number, code: number, durationMs: number): void {
    this.patch(index, { status: code === 0 ? 'passed' : 'failed', durationMs, running: [] });
  }

  /** Marks the run finished and writes it now. */
  close(code: number): void {
    this.file.value.status = code === 0 ? 'passed' : 'failed';
    this.file.value.finishedAt = this.file.now();
    this.file.flush();
  }

  private patch(index: number, fields: Partial<TestProgressSuite>): void {
    Object.assign(this.file.value.suites[index], fields);
    this.file.changed();
  }
}
