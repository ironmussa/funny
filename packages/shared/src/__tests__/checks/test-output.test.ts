import { describe, expect, test } from 'bun:test';

import { createOutputParser, TEST_EVENT_PREFIX } from '../../checks/test-output';

/** Counts after feeding a whole output. */
const feed = (output: string) => {
  const parse = createOutputParser(() => 0);
  let counts = parse('');
  for (const line of output.split('\n')) counts = parse(line);
  return counts;
};

const ESC = String.fromCharCode(27);

describe('createOutputParser failures', () => {
  test('vitest: a FAIL heading, its assertion and its location', () => {
    const counts = feed(
      [
        ` ${ESC}[31m❯${ESC}[39m packages/runtime/src/a.test.ts ${ESC}[2m(${ESC}[22m14 tests | 1 failed) 15ms`,
        `     × uses worktreePath as cwd when available 4ms`,
        '',
        '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
        '',
        `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m packages/runtime/src/a.test.ts ${ESC}[2m > ${ESC}[22magentCompletedQueueHandler${ESC}[2m > ${ESC}[22muses worktreePath as cwd when available`,
        `${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: expected "vi.fn()" to be called with arguments`,
        '',
        ` ❯ packages/runtime/src/a.test.ts:177:28`,
        '    175|',
        '',
        '      Tests  1 failed | 13 passed (14)',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 13, failed: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'agentCompletedQueueHandler > uses worktreePath as cwd when available',
        file: 'packages/runtime/src/a.test.ts',
        line: 177,
        message: 'AssertionError: expected "vi.fn()" to be called with arguments',
      },
    ]);
  });

  test('vitest reporter events carry the failure', () => {
    const parse = createOutputParser(() => 0);
    const counts = parse(
      `${TEST_EVENT_PREFIX}${JSON.stringify({
        e: 'test',
        file: 'src/a.test.ts',
        name: 'a > breaks',
        state: 'failed',
        ms: 3,
        error: { message: 'expected 1 to be 2', line: 12 },
      })}`,
    );
    expect(counts.failures).toEqual([
      { name: 'a > breaks', file: 'src/a.test.ts', line: 12, message: 'expected 1 to be 2' },
    ]);
  });

  test('bun test: the error and frame before a (fail) line belong to it', () => {
    const counts = feed(
      [
        '(pass) pipeline > starts [0.20ms]',
        'error: expect(received).toBe(expected)',
        'Expected: "a"',
        'Received: "b"',
        '      at <anonymous> (/home/u/funny/packages/runtime/src/p.test.ts:162:22)',
        '      at helper (/home/u/funny/packages/runtime/src/helper.ts:9:3)',
        '(fail) pipeline > uses commit SHA [1.00ms]',
        '',
        ' 1 pass',
        ' 1 fail',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 1, failed: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'pipeline > uses commit SHA',
        file: '/home/u/funny/packages/runtime/src/p.test.ts',
        line: 162,
        message: 'expect(received).toBe(expected)',
      },
    ]);
  });

  test('jest: ● heading, message and frame, then the Tests: summary', () => {
    const counts = feed(
      [
        'FAIL src/sum.test.ts',
        '  ● math › adds',
        '',
        '    expect(received).toBe(expected) // Object.is equality',
        '',
        '      at Object.<anonymous> (src/sum.test.ts:4:15)',
        '',
        'Tests:       1 failed, 1 skipped, 10 passed, 12 total',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 10, failed: 1, skipped: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'math › adds',
        file: 'src/sum.test.ts',
        line: 4,
        message: 'expect(received).toBe(expected) // Object.is equality',
      },
    ]);
  });

  test('playwright: list lines, the numbered heading and the summary', () => {
    const counts = feed(
      [
        'Running 3 tests using 3 workers',
        '  ✓  3 [chromium] › e2e/participants.spec.ts:27:7 › Participants › fills the form (3.5s)',
        '  ✓  2 [chromium] › e2e/tags.spec.ts:21:7 › Tags › adds a tag (3.8s)',
        '  ✘  1 [chromium] › e2e/tags.spec.ts:188:7 › Tags › adds a camera (13.8s)',
        '',
        '  1) [chromium] › e2e/tags.spec.ts:188:7 › Tags › adds a camera ',
        '',
        '    Error: expect(locator).toContainText(expected) failed',
        '',
        '  1 failed',
        '  2 passed (20.1s)',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 2, failed: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'Tags › adds a camera',
        file: 'e2e/tags.spec.ts',
        line: 188,
        message: 'Error: expect(locator).toContainText(expected) failed',
      },
    ]);
  });

  test('pytest: traceback header, E line, location, FAILED line and summary', () => {
    const counts = feed(
      [
        'tests/test_client.py ..F.s                                              [100%]',
        '=================================== FAILURES ===================================',
        '____ TestStart.test_message_format ____',
        '',
        'self = <tests.test_client.TestStart object at 0x75cf>',
        '>       assert msg["language"] == "es"',
        "E       AssertionError: assert 'en' == 'es'",
        'E         - es',
        '',
        'tests/test_client.py:61: AssertionError',
        '=========================== short test summary info ============================',
        "FAILED tests/test_client.py::TestStart::test_message_format - AssertionError: assert 'en' == 'es'",
        '==================== 1 failed, 3 passed, 1 skipped in 1.23s ====================',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 3, failed: 1, skipped: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'TestStart::test_message_format',
        file: 'tests/test_client.py',
        line: 61,
        message: "AssertionError: assert 'en' == 'es'",
      },
    ]);
  });

  test('go test: --- FAIL with its location line, ok / FAIL per package', () => {
    const counts = feed(
      [
        'ok  \tgithub.com/x/e-queue/internal/admitter\t0.012s',
        '--- FAIL: TestJoinWaitsBehindQueue (0.01s)',
        '    store_test.go:72: c skipped the line',
        'FAIL',
        'FAIL\tgithub.com/x/e-queue/internal/queue\t0.022s',
        'ok  \tgithub.com/x/e-queue/internal/tokens\t(cached)',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ failed: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'TestJoinWaitsBehindQueue',
        file: 'store_test.go',
        line: 72,
        message: 'c skipped the line',
      },
    ]);
  });

  test('cargo test: FAILED line, then the panic location and message', () => {
    const counts = feed(
      [
        'test grpc::a ... ok',
        'test grpc::b ... FAILED',
        '',
        '---- grpc::b stdout ----',
        "thread 'grpc::b' panicked at src/grpc.rs:10:5:",
        'assertion `left == right` failed',
        'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 1, failed: 1, summarized: true });
    expect(counts.failures).toEqual([
      {
        name: 'grpc::b',
        file: 'src/grpc.rs',
        line: 10,
        message: 'assertion `left == right` failed',
      },
    ]);
  });

  test('a log cut before any summary is not summarized', () => {
    expect(
      feed(' ✓ src/a.test.ts (5 tests) 120ms\n ✓ src/b.test.ts (2 tests) 4ms').summarized,
    ).toBe(false);
  });
});

describe('createOutputParser files', () => {
  test('bun test: the tests under each file header, with their durations', () => {
    const counts = feed(
      [
        'src/a.test.ts:',
        '(pass) a > adds [0.20ms]',
        '(skip) a > later',
        '',
        'src/b.test.ts:',
        'error: expect(received).toBe(expected)',
        '      at <anonymous> (/home/u/src/b.test.ts:9:3)',
        '(fail) b > breaks [1.50ms]',
        '',
        ' 1 pass',
        ' 1 skip',
        ' 1 fail',
      ].join('\n'),
    );
    expect(counts.files).toEqual([
      {
        name: 'src/a.test.ts',
        passed: 1,
        failed: 0,
        skipped: 1,
        tests: [
          { name: 'a > adds', state: 'passed', durationMs: 0.2 },
          { name: 'a > later', state: 'skipped' },
        ],
      },
      {
        name: 'src/b.test.ts',
        passed: 0,
        failed: 1,
        skipped: 0,
        tests: [{ name: 'b > breaks', state: 'failed', durationMs: 1.5 }],
      },
    ]);
  });

  test('vitest: per-file counts from the default reporter, tests from its events', () => {
    const lines = feed(
      ' ✓ src/a.test.ts (5 tests | 1 skipped) 120ms\n ❯ src/b.test.ts (2 tests | 1 failed) 1.2s',
    );
    expect(lines.files).toEqual([
      {
        name: 'src/a.test.ts',
        status: 'passed',
        passed: 4,
        failed: 0,
        skipped: 1,
        durationMs: 120,
        tests: [],
      },
      {
        name: 'src/b.test.ts',
        status: 'failed',
        passed: 1,
        failed: 1,
        skipped: 0,
        durationMs: 1200,
        tests: [],
      },
    ]);

    const event = (body: object) => `${TEST_EVENT_PREFIX}${JSON.stringify(body)}`;
    const events = feed(
      [
        event({ e: 'file', file: 'src/a.test.ts' }),
        event({ e: 'test', file: 'src/a.test.ts', name: 'a > adds', state: 'passed', ms: 3 }),
        event({ e: 'file-end', file: 'src/a.test.ts', ms: 40 }),
        // The default reporter's line for the same file is not counted twice.
        ' ✓ src/a.test.ts (1 test) 40ms',
      ].join('\n'),
    );
    expect(events.files).toEqual([
      {
        name: 'src/a.test.ts',
        passed: 1,
        failed: 0,
        skipped: 0,
        durationMs: 40,
        tests: [{ name: 'a > adds', state: 'passed', durationMs: 3 }],
      },
    ]);
  });

  test('playwright, pytest, jest and go name their files or packages', () => {
    const playwright = feed('  ✓  1 [chromium] › e2e/tags.spec.ts:21:7 › Tags › adds a tag (3.8s)');
    expect(playwright.files).toMatchObject([
      {
        name: 'e2e/tags.spec.ts',
        passed: 1,
        tests: [{ name: 'Tags › adds a tag', state: 'passed' }],
      },
    ]);

    const pytest = feed('tests/test_a.py ..F  [ 60%]\ntests/test_b.py::test_x PASSED');
    expect(pytest.files).toMatchObject([
      { name: 'tests/test_a.py', passed: 2, failed: 1, tests: [] },
      { name: 'tests/test_b.py', passed: 1, tests: [{ name: 'test_x', state: 'passed' }] },
    ]);

    const jest = feed('PASS src/a.test.ts (1.2 s)\nFAIL src/b.test.ts');
    expect(jest.files).toMatchObject([
      { name: 'src/a.test.ts', status: 'passed' },
      { name: 'src/b.test.ts', status: 'failed' },
    ]);

    const go = feed('--- PASS: TestA (0.00s)\nok  \tgithub.com/x/q\t0.01s');
    expect(go.files).toMatchObject([
      { name: 'github.com/x/q', status: 'passed', passed: 1, tests: [{ name: 'TestA' }] },
    ]);
  });
});

describe('createOutputParser chained runs', () => {
  test('each runner summary adds to the runs before it, instead of replacing them', () => {
    const counts = feed(
      [
        'bun test v1.4.4',
        ' 83 pass',
        ' 0 fail',
        'Ran 83 tests across 4 files. [38.00ms]',
        ' RUN  v4.1.12 /repo/packages/core',
        ' ✓ src/a.test.ts (12 tests) 6ms',
        '      Tests  12 passed (12)',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 95, failed: 0, summarized: true });
  });

  test('two bun runs, with their tests listed', () => {
    const counts = feed(
      [
        '(pass) a > one',
        '(fail) a > two',
        ' 1 pass',
        ' 1 fail',
        '(pass) b > one',
        '(skip) b > later',
        ' 1 pass',
        ' 0 fail',
        ' 1 skip',
      ].join('\n'),
    );
    expect(counts).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
  });
});
