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

import { TEST_EVENT_PREFIX, type TestEvent } from '../packages/shared/src/checks';

const emit = (event: TestEvent) =>
  process.stdout.write(`${TEST_EVENT_PREFIX}${JSON.stringify(event)}\n`);

const fileOf = (moduleId: string) => relative(process.cwd(), moduleId);

/** A failed test's first error, and the line in its own file it was thrown from. */
function firstError(
  errors:
    | ReadonlyArray<{ message?: string; stacks?: { file: string; line: number }[] }>
    | undefined,
  moduleId: string,
): { message: string; line?: number } {
  const error = errors?.[0];
  const message = (error?.message ?? 'failed').split('\n')[0].slice(0, 300);
  const line = error?.stacks?.find((frame) => frame.file === moduleId)?.line;
  return line ? { message, line } : { message };
}

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
    const result = testCase.result();
    const file = fileOf(testCase.module.moduleId);
    emit({
      e: 'test',
      file,
      name: testCase.fullName,
      state: STATES[result.state] ?? 'skipped',
      ms: testCase.diagnostic()?.duration ?? 0,
      ...(result.state === 'failed'
        ? { error: firstError(result.errors, testCase.module.moduleId) }
        : {}),
    });
  }

  onTestModuleEnd(module: TestModule): void {
    emit({ e: 'file-end', file: fileOf(module.moduleId), ms: module.diagnostic().duration });
  }
}
