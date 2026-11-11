// Reads a test runner's output line by line and pulls out what the
// test-progress widget shows: passed / failed / skipped counts, the file or
// test reported last, the failures (name, file, line, message), and, from
// funny's vitest reporter events, the files running and the slow ones.
//
// Understands vitest, bun test, jest, playwright, pytest, cargo test and go
// test output, so the runner does not need to know which tool printed it.
// `summarized` turns true when a runner printed its final summary: without
// it, the counts of a finished run are a partial view (e.g. a truncated log).

import { z } from 'zod';

import { parseStoredJson } from '../json-validation.js';
import {
  SLOW_TEST_MS,
  TEST_FAILURE_LIMIT,
  type TestFailure,
  type TestProgressSlowEntry,
} from '../test-progress.js';
import { cleanLine } from './text.js';

/** Starts an event line from funny's vitest progress reporter; JSON follows. */
export const TEST_EVENT_PREFIX = '##funny-test ';

/** A progress event a reporter prints after `TEST_EVENT_PREFIX`. */
const testEventSchema = z.discriminatedUnion('e', [
  z.object({ e: z.literal('run'), files: z.number() }),
  z.object({ e: z.literal('file'), file: z.string() }),
  z.object({
    e: z.literal('test'),
    file: z.string(),
    name: z.string(),
    state: z.enum(['passed', 'failed', 'skipped']),
    ms: z.number(),
    /** For a failed test: the first error and where it was thrown. */
    error: z.object({ message: z.string(), line: z.number().optional() }).optional(),
  }),
  z.object({ e: z.literal('file-end'), file: z.string(), ms: z.number() }),
]);

export type TestEvent = z.infer<typeof testEventSchema>;

/** Slow entries kept per suite. */
const SLOW_LIMIT = 20;
/** Lines after a failure's heading searched for its message and location. */
const DETAIL_LINES = 12;
const MESSAGE_MAX = 300;

/** What a parser extracts from a suite's output so far. */
export interface SuiteCounts {
  passed: number;
  failed: number;
  skipped: number;
  current?: string;
  filesTotal?: number;
  filesDone?: number;
  running: { file: string; startedAt: number }[];
  slow: TestProgressSlowEntry[];
  failures: TestFailure[];
  /** A runner printed its final summary. */
  summarized: boolean;
}

/** Feeds output lines; returns the counts seen so far. */
export type OutputParser = (line: string) => SuiteCounts;

/** The counts as test-progress suite fields (without the parser's own flags). */
export function suiteFields(counts: SuiteCounts): Omit<SuiteCounts, 'summarized'> {
  const fields: Partial<SuiteCounts> = { ...counts };
  delete fields.summarized;
  return fields as Omit<SuiteCounts, 'summarized'>;
}

/** Where a stack frame or location line points: `(file:line:col)`, ` ❯ file:line:col`. */
const FRAME = /(?:\(|❯\s+|at\s+)((?:[A-Za-z]:)?[^\s():]+\.\w+):(\d+):\d+\)?\s*$/;
/** Separators and blank-ish lines that are never a failure's message. */
const NOISE = /^[\s⎯─━=\-_*>]*$|^\s*\d+\s*\||^\s*\|/;

interface Pending {
  failure: TestFailure;
  linesLeft: number;
}

class Counter {
  readonly counts: SuiteCounts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    running: [],
    slow: [],
    failures: [],
    summarized: false,
  };
  /** A failure whose heading was printed, waiting for its message / location. */
  private pending: Pending | null = null;
  /** bun prints a failure's error before its `(fail)` line. */
  private lastError: { message?: string; file?: string; line?: number } = {};
  fromEvents = false;

  bump(state: 'passed' | 'failed' | 'skipped', current?: string): void {
    this.counts[state]++;
    if (current) this.counts.current = current;
  }

  totals(passed: number, failed: number, skipped: number): void {
    Object.assign(this.counts, { passed, failed, skipped, summarized: true });
  }

  /** Records a failure, merged with an earlier one of the same test. */
  fail(failure: TestFailure, awaitDetail: boolean): void {
    const same = this.counts.failures.find(
      (f) => f.name === failure.name && (!f.file || !failure.file || f.file === failure.file),
    );
    const target = same ?? failure;
    if (same) Object.assign(same, { ...failure, ...stripEmpty(same) });
    else if (this.counts.failures.length < TEST_FAILURE_LIMIT) {
      this.counts.failures = [...this.counts.failures, failure];
    }
    this.pending = awaitDetail ? { failure: target, linesLeft: DETAIL_LINES } : null;
  }

  /** Fills the pending failure's message and location from the lines after it. */
  detail(line: string): void {
    const frame = FRAME.exec(line);
    // The first frame is the test's own line; later ones are its callers.
    if (frame && !this.lastError.file) {
      this.lastError = { ...this.lastError, file: frame[1], line: Number(frame[2]) };
    }
    const error = /^error: (.+)$/.exec(line.trim());
    if (error) this.lastError = { message: error[1].slice(0, MESSAGE_MAX) };

    const pending = this.pending;
    if (!pending) return;
    if (--pending.linesLeft <= 0) this.pending = null;
    const { failure } = pending;
    if (frame && failure.line === undefined && (!failure.file || failure.file === frame[1])) {
      failure.file = frame[1];
      failure.line = Number(frame[2]);
    } else if (!frame && !failure.message && !NOISE.test(line)) {
      failure.message = line.trim().slice(0, MESSAGE_MAX);
    }
    if (failure.message && failure.line !== undefined) this.pending = null;
  }

  /** bun's `(fail) name`: the error printed just before it belongs to it. */
  failFromLastError(name: string): void {
    this.fail({ name, ...this.lastError }, false);
    this.lastError = {};
  }

  resetLastError(): void {
    this.lastError = {};
  }

  slow(entry: TestProgressSlowEntry): void {
    if (entry.durationMs < SLOW_TEST_MS) return;
    this.counts.slow = [...this.counts.slow, entry]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, SLOW_LIMIT);
  }
}

function stripEmpty(failure: TestFailure): Partial<TestFailure> {
  return Object.fromEntries(Object.entries(failure).filter(([, v]) => v !== undefined));
}

const count = (text: string, word: string) =>
  Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);

/**
 * vitest's default reporter prints one line per finished file:
 *   ` ✓ |unit| src/a.test.ts (5 tests) 120ms`
 *   ` ❯ src/b.test.ts (4 tests | 1 failed) 80ms`
 * a ` FAIL  src/b.test.ts > suite > name` heading per failure, and a final
 * `Tests  12 passed | 1 failed (13)`, which replaces the sum. With reporter
 * events the file lines are skipped: the events already counted those tests.
 */
function vitestLine(c: Counter, line: string): boolean {
  const file = /^\s*[✓×❯↓]\s+(?:\|[^|]+\|\s+)?(\S+)\s+\((\d+) tests?([^)]*)\)/.exec(line);
  if (file) {
    if (c.fromEvents) return true;
    const failed = count(file[3], 'failed');
    const skipped = count(file[3], 'skipped');
    c.counts.passed += Number(file[2]) - failed - skipped;
    c.counts.failed += failed;
    c.counts.skipped += skipped;
    c.counts.current = file[1];
    return true;
  }
  const heading = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+)$/.exec(line);
  if (heading) {
    c.fail({ name: heading[2].trim(), file: heading[1] }, true);
    return true;
  }
  const summary = /^\s*Tests\s+(.+)\(\d+\)\s*$/.exec(line);
  if (!summary) return false;
  c.totals(
    count(summary[1], 'passed'),
    count(summary[1], 'failed'),
    count(summary[1], 'skipped') + count(summary[1], 'todo'),
  );
  return true;
}

/**
 * bun test prints `(pass) name [1ms]`, `(fail) …`, `(skip) …` / `(todo) …`
 * (a failure after its error and stack), and always a summary: ` 535 pass`,
 * ` 0 fail`, ` 2 skip`, ` 1 todo`, one per line, which replaces the sum.
 */
function bunLine(c: Counter, line: string): boolean {
  const summary = /^\s*(\d+) (pass|fail|skip|todo)$/.exec(line);
  if (summary) {
    const n = Number(summary[1]);
    if (summary[2] === 'pass') c.counts.passed = n;
    else if (summary[2] === 'fail') c.counts.failed = n;
    else c.counts.skipped = summary[2] === 'skip' ? n : c.counts.skipped + n;
    c.counts.summarized = true;
    return true;
  }
  const test = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
  if (!test) return false;
  if (test[1] === 'fail') {
    c.bump('failed', test[2]);
    c.failFromLastError(test[2]);
  } else {
    c.bump(test[1] === 'pass' ? 'passed' : 'skipped', test[2]);
    c.resetLastError();
  }
  return true;
}

/**
 * jest prints `PASS src/a.test.ts` / `FAIL …` per file, a `● suite › name`
 * heading per failure, and `Tests:  1 failed, 2 skipped, 10 passed, 13 total`.
 */
function jestLine(c: Counter, line: string): boolean {
  const file = /^\s*(PASS|FAIL)\s+(\S+\.\w+)(?:\s+\([\d.]+ m?s\))?$/.exec(line);
  if (file) {
    c.counts.current = file[2];
    return true;
  }
  const heading = /^\s*● (.+ › .+|[^:]+)$/.exec(line);
  if (heading && !/^Test suite failed to run$/.test(heading[1])) {
    c.fail({ name: heading[1].trim() }, true);
    return true;
  }
  const summary = /^Tests:\s+(.+) total$/.exec(line.trim());
  if (!summary) return false;
  c.totals(
    count(summary[1], 'passed'),
    count(summary[1], 'failed'),
    count(summary[1], 'skipped') + count(summary[1], 'todo'),
  );
  return true;
}

/**
 * playwright's list reporter: `  ✓  1 [chromium] › a.spec.ts:3:1 › title (1.2s)`
 * (`✘` failed, `-` skipped), a `1) [chromium] › a.spec.ts:3:5 › title ───`
 * heading per failure, and summary lines `3 passed (5.1s)`, `1 failed`, ….
 */
function playwrightLine(c: Counter, line: string): boolean {
  const test = /^\s*([✓✘-]|ok|x)\s+\d+\s+(.*›.+?)(?:\s+\([\d.]+m?s\))?$/.exec(line);
  if (test) {
    const state =
      test[1] === '✓' || test[1] === 'ok' ? 'passed' : test[1] === '-' ? 'skipped' : 'failed';
    c.bump(state, test[2].trim());
    return true;
  }
  const heading = /^\s*\d+\) (?:\[[^\]]+\] › )?(\S+?):(\d+):\d+ › (.+?)\s*[─]*$/.exec(line);
  if (heading) {
    c.fail({ name: heading[3], file: heading[1], line: Number(heading[2]) }, true);
    return true;
  }
  const summary = /^\s*(\d+) (passed|failed|skipped|flaky|did not run)(?: \(.+\))?$/.exec(line);
  if (!summary) return false;
  const n = Number(summary[1]);
  if (summary[2] === 'passed' || summary[2] === 'flaky') c.counts.passed = n;
  else if (summary[2] === 'failed') c.counts.failed = n;
  else c.counts.skipped = n;
  c.counts.summarized = true;
  return true;
}

/**
 * pytest: progress lines `tests/test_a.py ..F.s  [ 40%]`, verbose lines
 * `tests/test_a.py::test_x PASSED`, short-summary `FAILED path::name - msg`,
 * and the final `==== 2 failed, 10 passed, 1 skipped in 1.23s ====`.
 */
function pytestLine(c: Counter, line: string): boolean {
  const dots = /^(\S+\.py) ([.FsExX]+)\s*(?:\[\s*\d+%\])?$/.exec(line);
  if (dots) {
    for (const ch of dots[2])
      c.bump(ch === '.' || ch === 'X' ? 'passed' : ch === 'F' || ch === 'E' ? 'failed' : 'skipped');
    c.counts.current = dots[1];
    return true;
  }
  const verbose = /^(\S+\.py)::(\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/.exec(line);
  if (verbose) {
    const state =
      verbose[3] === 'PASSED' || verbose[3] === 'XPASS'
        ? 'passed'
        : verbose[3] === 'FAILED' || verbose[3] === 'ERROR'
          ? 'failed'
          : 'skipped';
    c.bump(state, `${verbose[1]}::${verbose[2]}`);
    return true;
  }
  const failed = /^(?:FAILED|ERROR) (\S+\.py)::(\S+)(?: - (.+))?$/.exec(line);
  if (failed) {
    c.fail(
      {
        name: failed[2],
        file: failed[1],
        ...(failed[3] ? { message: failed[3].slice(0, MESSAGE_MAX) } : {}),
      },
      false,
    );
    return true;
  }
  // The traceback of each failure: `____ Class.test_name ____`, `E  message`
  // lines, and `tests/test_a.py:61: AssertionError` where it was raised.
  const header = /^_{3,} (\S+) _{3,}$/.exec(line);
  if (header) {
    c.fail({ name: header[1].replace(/\./g, '::') }, false);
    return true;
  }
  const open = () => [...c.counts.failures].reverse().find((f) => f.line === undefined);
  const raised = /^E\s+(\S.*)$/.exec(line);
  if (raised) {
    const failure = open();
    if (failure && !failure.message) failure.message = raised[1].slice(0, MESSAGE_MAX);
    return true;
  }
  const location = /^(\S+\.py):(\d+): \w+/.exec(line);
  if (location) {
    const failure = open();
    if (failure && (!failure.file || failure.file === location[1])) {
      Object.assign(failure, { file: location[1], line: Number(location[2]) });
    }
  }
  const summary =
    /^=+ (.*\b(?:passed|failed|skipped|error|errors|no tests ran)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/.exec(
      line,
    );
  if (!summary) return Boolean(location);
  c.totals(
    count(summary[1], 'passed') + count(summary[1], 'xpassed'),
    count(summary[1], 'failed') + count(summary[1], 'errors?'),
    count(summary[1], 'skipped') + count(summary[1], 'xfailed'),
  );
  return true;
}

/**
 * cargo test prints `test path::name ... ok` / `FAILED` / `ignored`, per
 * binary `test result: ok. 5 passed; 0 failed; 1 ignored; …`, and for a
 * failure `thread 'path::name' panicked at src/lib.rs:10:5:` then the message.
 */
function cargoLine(c: Counter, line: string): boolean {
  if (line.startsWith('test result:')) {
    c.counts.summarized = true;
    return true;
  }
  const test = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line);
  if (test) {
    c.bump(test[2] === 'ok' ? 'passed' : test[2] === 'FAILED' ? 'failed' : 'skipped', test[1]);
    if (test[2] === 'FAILED') c.fail({ name: test[1] }, false);
    return true;
  }
  const panic = /^thread '([^']+)' panicked at (\S+?):(\d+):\d+:?$/.exec(line);
  if (!panic) return false;
  c.fail({ name: panic[1], file: panic[2], line: Number(panic[3]) }, true);
  return true;
}

/**
 * go test -v: `--- PASS: TestX (0.00s)` / `--- FAIL:` / `--- SKIP:`, the
 * failure's `    a_test.go:12: message` right after, and `ok  pkg 0.1s` /
 * `FAIL\tpkg 0.1s` per package.
 */
function goLine(c: Counter, line: string): boolean {
  const test = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(line);
  if (test) {
    c.bump(test[1] === 'PASS' ? 'passed' : test[1] === 'FAIL' ? 'failed' : 'skipped', test[2]);
    if (test[1] === 'FAIL') c.fail({ name: test[2] }, false);
    return true;
  }
  const at = /^\s+(\S+_test\.go):(\d+): (.+)$/.exec(line);
  if (at) {
    const open = [...c.counts.failures].reverse().find((f) => !f.file);
    if (open)
      Object.assign(open, {
        file: at[1],
        line: Number(at[2]),
        message: at[3].slice(0, MESSAGE_MAX),
      });
    return true;
  }
  const pkg = /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\))/.exec(line);
  if (!pkg) return false;
  c.counts.current = pkg[2];
  c.counts.summarized = true;
  return true;
}

const STATE_FIELD = { passed: 'passed', failed: 'failed', skipped: 'skipped' } as const;

function applyEvent(c: Counter, event: TestEvent, now: number): void {
  const counts = c.counts;
  switch (event.e) {
    case 'run':
      counts.filesTotal = event.files;
      counts.filesDone = 0;
      return;
    case 'file':
      counts.running = [...counts.running, { file: event.file, startedAt: now }];
      counts.current = event.file;
      return;
    case 'test':
      counts[STATE_FIELD[event.state]]++;
      if (event.state === 'failed') {
        const { message, line } = event.error ?? {};
        c.fail(
          {
            name: event.name,
            file: event.file,
            ...stripEmpty({ name: event.name, message, line }),
          },
          false,
        );
      }
      c.slow({ kind: 'test', name: `${event.file} › ${event.name}`, durationMs: event.ms });
      return;
    case 'file-end':
      counts.running = counts.running.filter((run) => run.file !== event.file);
      counts.filesDone = (counts.filesDone ?? 0) + 1;
      c.slow({ kind: 'file', name: event.file, durationMs: event.ms });
  }
}

/** The event on a reporter line, or null for any other line. */
function parseEvent(line: string): TestEvent | null {
  const at = line.indexOf(TEST_EVENT_PREFIX);
  if (at === -1) return null;
  const parsed = parseStoredJson(
    testEventSchema,
    line.slice(at + TEST_EVENT_PREFIX.length),
    'test event',
  );
  return parsed.ok ? parsed.value : null;
}

/** Whether a line is a reporter event (kept out of the printed output). */
export const isEventLine = (line: string) => line.includes(TEST_EVENT_PREFIX);

/** First match wins: a line belongs to one runner's format. */
const LINE_READERS = [vitestLine, bunLine, jestLine, playwrightLine, pytestLine, cargoLine, goLine];

/**
 * A parser that understands reporter events and the output of every runner
 * above alike. `now` stamps when a file started running.
 */
export function createOutputParser(now: () => number = Date.now): OutputParser {
  const c = new Counter();
  return (raw) => {
    const event = parseEvent(raw);
    if (event) {
      c.fromEvents = true;
      applyEvent(c, event, now());
    } else {
      const line = cleanLine(raw);
      if (!LINE_READERS.some((read) => read(c, line))) c.detail(line);
    }
    return { ...c.counts };
  };
}
