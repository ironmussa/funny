// A vitest reporter that prints machine-readable progress events, one per line,
// for `run-tests.ts` to turn into the live test progress file. vitest's default
// reporter, writing to a pipe, prints only the final summary, so without this a
// suite's counts would jump from 0 to the total when it ends.
//
// Each event is a line `TEST_EVENT_PREFIX` + JSON (see `TestEvent` in
// test-progress.ts). `run-tests.ts` adds it next to the default reporter only
// when `FUNNY_TEST_PROGRESS` is set, and drops these lines from the printed output.

import { relative } from 'node:path';

import type { Reporter, TestCase, TestModule, TestSpecification } from 'vitest/node';

import { TEST_EVENT_PREFIX, type TestEvent } from './test-progress';

const emit = (event: TestEvent) =>
  process.stdout.write(`${TEST_EVENT_PREFIX}${JSON.stringify(event)}\n`);

const fileOf = (moduleId: string) => relative(process.cwd(), moduleId);

const STATES = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped' };

export default class ProgressReporter implements Reporter {
  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    emit({ e: 'run', files: new Set(specifications.map((spec) => spec.moduleId)).size });
  }

  // Queued = handed to a worker, before its imports load: in suites where
  // imports are the expensive part, this is when the file starts costing time.
  onTestModuleQueued(module: TestModule): void {
    emit({ e: 'file', file: fileOf(module.moduleId) });
  }

  onTestCaseResult(testCase: TestCase): void {
    emit({
      e: 'test',
      file: fileOf(testCase.module.moduleId),
      name: testCase.fullName,
      state: STATES[testCase.result().state] ?? 'skipped',
      ms: testCase.diagnostic()?.duration ?? 0,
    });
  }

  onTestModuleEnd(module: TestModule): void {
    emit({ e: 'file-end', file: fileOf(module.moduleId), ms: module.diagnostic().duration });
  }
}
