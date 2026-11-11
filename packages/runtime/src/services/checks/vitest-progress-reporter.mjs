// A vitest reporter that prints machine-readable progress events, one per line:
// `##funny-test ` + JSON (`TestEvent` in `@funny/shared/checks`). vitest's
// default reporter, writing to a pipe, prints only the final summary, so
// without this a suite's counts would jump from 0 to the total when it ends.
//
// It runs inside the project's own vitest (`--reporter=<this file>`), in any
// repository, so it imports nothing: plain JS, copied next to the runtime
// bundle like `pty-helper.mjs`. Used by the runtime's check runner and by
// `scripts/run-tests.ts`, which add it next to the default reporter and keep
// these lines out of the printed output.

import { relative } from 'node:path';

/** Keep in sync with `TEST_EVENT_PREFIX` in `@funny/shared/checks` (tested). */
export const TEST_EVENT_PREFIX = '##funny-test ';

const emit = (event) => process.stdout.write(`${TEST_EVENT_PREFIX}${JSON.stringify(event)}\n`);

const fileOf = (moduleId) => relative(process.cwd(), moduleId);

const STATES = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped' };

/** A failed test's first error, and the line in its own file it was thrown from. */
function firstError(errors, moduleId) {
  const error = errors?.[0];
  const message = String(error?.message ?? 'failed')
    .split('\n')[0]
    .slice(0, 300);
  const line = error?.stacks?.find((frame) => frame.file === moduleId)?.line;
  return line ? { message, line } : { message };
}

export default class ProgressReporter {
  onTestRunStart(specifications) {
    emit({ e: 'run', files: new Set(specifications.map((spec) => spec.moduleId)).size });
  }

  // Queued = handed to a worker, before its imports load: in suites where
  // imports are the expensive part, this is when the file starts costing time.
  onTestModuleQueued(module) {
    emit({ e: 'file', file: fileOf(module.moduleId) });
  }

  onTestCaseResult(testCase) {
    const result = testCase.result();
    emit({
      e: 'test',
      file: fileOf(testCase.module.moduleId),
      name: testCase.fullName,
      state: STATES[result.state] ?? 'skipped',
      ms: testCase.diagnostic()?.duration ?? 0,
      ...(result.state === 'failed'
        ? { error: firstError(result.errors, testCase.module.moduleId) }
        : {}),
    });
  }

  onTestModuleEnd(module) {
    emit({ e: 'file-end', file: fileOf(module.moduleId), ms: module.diagnostic().duration });
  }
}
