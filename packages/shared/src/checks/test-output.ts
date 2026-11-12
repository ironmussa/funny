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
  TEST_FILE_LIMIT,
  TEST_NAME_LIMIT,
  type TestFailure,
  type TestFileResult,
  type TestProgressSlowEntry,
} from '../test-progress.js';
import { cleanLine } from './text.js';

type TestState = 'passed' | 'failed' | 'skipped';

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
  files: TestFileResult[];
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

/** Gives a failure the frame's location, unless it has one or the frame is another file's. */
function placeAt(failure: TestFailure, frame: RegExpExecArray): void {
  if (failure.line !== undefined) return;
  if (failure.file && failure.file !== frame[1]) return;
  Object.assign(failure, { file: frame[1], line: Number(frame[2]) });
}

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
    files: [],
    summarized: false,
  };
  /** The file (or package) the runner is reporting tests for now. */
  private file: string | undefined;
  /** Tests listed by name so far, across files (`TEST_NAME_LIMIT`). */
  private named = 0;
  /** A failure whose heading was printed, waiting for its message / location. */
  private pending: Pending | null = null;
  /** bun prints a failure's error before its `(fail)` line. */
  private lastError: { message?: string; file?: string; line?: number } = {};
  fromEvents = false;
  /**
   * Counts of the runs that already printed their summary: one command may
   * chain several (`bun test && vitest run`), and each summary is its own run's.
   */
  private base = { passed: 0, failed: 0, skipped: 0 };
  /** A summary was printed and no test of a next run has been counted since. */
  private closed = false;

  /** Counts tests reported one by one; the first after a summary starts a new run. */
  add(state: TestState, n = 1): void {
    if (this.closed) {
      const { passed, failed, skipped } = this.counts;
      this.base = { passed, failed, skipped };
      this.closed = false;
    }
    this.counts[state] += n;
  }

  /** A runner's summary: its run's totals, on top of the runs before it. */
  summary(totals: Partial<Record<TestState, number>>): void {
    for (const [state, n] of Object.entries(totals) as [TestState, number][]) {
      this.counts[state] = this.base[state] + n;
    }
    this.counts.summarized = true;
    this.closed = true;
  }

  bump(state: TestState, current?: string): void {
    this.add(state);
    if (current) this.counts.current = current;
  }

  /** The entry for a file, added on first sight (empty name: tests without a file). */
  private fileEntry(name: string): TestFileResult | undefined {
    const files = this.counts.files;
    const found = files.find((f) => f.name === name);
    if (found || files.length >= TEST_FILE_LIMIT) return found;
    const entry: TestFileResult = { name, passed: 0, failed: 0, skipped: 0, tests: [] };
    this.counts.files = [...files, entry];
    return entry;
  }

  /** The runner started reporting a file's tests. */
  enterFile(name: string): void {
    this.file = name;
    this.fileEntry(name);
  }

  /**
   * One test: counted, and listed under its file (`file`, else the current
   * one) by name when the runner printed it.
   */
  test(
    state: TestState,
    name: string | undefined,
    at: { file?: string; current?: string; durationMs?: number } = {},
  ): void {
    this.bump(state, at.current);
    const entry = this.fileEntry(at.file ?? this.file ?? '');
    if (!entry) return;
    entry[state]++;
    if (name === undefined || this.named >= TEST_NAME_LIMIT) return;
    entry.tests.push({ name, state, ...stripEmpty({ durationMs: at.durationMs }) });
    this.named++;
  }

  /** A file's own counts, when the runner prints them per file (vitest's default reporter). */
  fileTotals(name: string, totals: Pick<TestFileResult, 'passed' | 'failed' | 'skipped'>): void {
    const entry = this.fileEntry(name);
    if (entry) Object.assign(entry, totals);
  }

  /** A file finished: its outcome and duration, when the runner prints them. */
  fileDone(name: string, done: Pick<TestFileResult, 'status' | 'durationMs'>): void {
    const entry = this.fileEntry(name);
    if (entry) Object.assign(entry, stripEmpty(done));
  }

  /** go test names the package after its tests: they move under it. */
  namePackage(name: string, status: 'passed' | 'failed'): void {
    const anonymous = this.counts.files.find((f) => f.name === '');
    if (anonymous) Object.assign(anonymous, { name, status });
    else this.fileDone(name, { status });
  }

  totals(passed: number, failed: number, skipped: number): void {
    this.summary({ passed, failed, skipped });
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

  /** Reads a line no runner format claimed: error details for the failures. */
  detail(line: string): void {
    const frame = FRAME.exec(line);
    this.noteError(line, frame);
    if (this.pending) this.fillPending(this.pending, line, frame);
  }

  /** bun prints a failure's error and stack before its `(fail)` line. */
  private noteError(line: string, frame: RegExpExecArray | null): void {
    // The first frame is the test's own line; later ones are its callers.
    if (frame && !this.lastError.file) {
      this.lastError = { ...this.lastError, file: frame[1], line: Number(frame[2]) };
    }
    const error = /^error: (.+)$/.exec(line.trim());
    if (error) this.lastError = { message: error[1].slice(0, MESSAGE_MAX) };
  }

  /** The pending failure's message (first meaningful line) and location (first frame). */
  private fillPending(pending: Pending, line: string, frame: RegExpExecArray | null): void {
    const { failure } = pending;
    if (frame) placeAt(failure, frame);
    else if (!failure.message && !NOISE.test(line))
      failure.message = line.trim().slice(0, MESSAGE_MAX);
    const done = failure.message && failure.line !== undefined;
    if (done || --pending.linesLeft <= 0) this.pending = null;
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

function stripEmpty<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const count = (text: string, word: string) =>
  Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);

/** One line format: a pattern and what a matching line means. */
type LineRule = [RegExp, (c: Counter, m: RegExpExecArray) => void];

/** The first rule whose pattern matches handles the line; true when one did. */
function readWith(rules: LineRule[]): (c: Counter, line: string) => boolean {
  return (c, line) => {
    for (const [pattern, handle] of rules) {
      const m = pattern.exec(line);
      if (m) {
        handle(c, m);
        return true;
      }
    }
    return false;
  };
}

/** Totals from a `12 passed | 1 failed | 2 skipped` style summary. */
function summaryTotals(
  c: Counter,
  text: string,
  extra: { passed?: string[]; failed?: string[]; skipped?: string[] } = {},
): void {
  const sum = (words: string[]) => words.reduce((n, word) => n + count(text, word), 0);
  c.totals(
    sum(['passed', ...(extra.passed ?? [])]),
    sum(['failed', ...(extra.failed ?? [])]),
    sum(['skipped', 'todo', ...(extra.skipped ?? [])]),
  );
}

const STATE_OF: Record<string, TestState> = {
  '✓': 'passed',
  ok: 'passed',
  '✘': 'failed',
  x: 'failed',
  '-': 'skipped',
  '.': 'passed',
  X: 'passed',
  F: 'failed',
  E: 'failed',
  s: 'skipped',
  PASSED: 'passed',
  XPASS: 'passed',
  FAILED: 'failed',
  ERROR: 'failed',
  SKIPPED: 'skipped',
  XFAIL: 'skipped',
  pass: 'passed',
  fail: 'failed',
  skip: 'skipped',
  todo: 'skipped',
  PASS: 'passed',
  FAIL: 'failed',
  SKIP: 'skipped',
};

const stateOf = (mark: string) => STATE_OF[mark] ?? 'skipped';

const withMessage = (message: string | undefined) =>
  message ? { message: message.slice(0, MESSAGE_MAX) } : {};

/**
 * vitest's default reporter prints one line per finished file:
 *   ` ✓ |unit| src/a.test.ts (5 tests) 120ms`
 *   ` ❯ src/b.test.ts (4 tests | 1 failed) 80ms`
 * a ` FAIL  src/b.test.ts > suite > name` heading per failure, and a final
 * `Tests  12 passed | 1 failed (13)`, which replaces the sum. With reporter
 * events the file lines are skipped: the events already counted those tests.
 */
const vitestLine = readWith([
  [
    /^\s*[✓×❯↓]\s+(?:\|[^|]+\|\s+)?(\S+)\s+\((\d+) tests?([^)]*)\)(?:\s+([\d.]+)(ms|s)\b)?/,
    (c, m) => {
      if (c.fromEvents) return;
      const failed = count(m[3], 'failed');
      const skipped = count(m[3], 'skipped');
      const passed = Number(m[2]) - failed - skipped;
      c.add('passed', passed);
      c.add('failed', failed);
      c.add('skipped', skipped);
      c.counts.current = m[1];
      c.fileTotals(m[1], { passed, failed, skipped });
      c.fileDone(m[1], {
        status: failed > 0 ? 'failed' : 'passed',
        durationMs: m[4] ? Number(m[4]) * (m[5] === 's' ? 1000 : 1) : undefined,
      });
    },
  ],
  [
    /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+)$/,
    (c, m) => c.fail({ name: m[2].trim(), file: m[1] }, true),
  ],
  [/^\s*Tests\s+(.+)\(\d+\)\s*$/, (c, m) => summaryTotals(c, m[1])],
]);

/**
 * bun test prints `(pass) name [1ms]`, `(fail) …`, `(skip) …` / `(todo) …`
 * (a failure after its error and stack), and always a summary: ` 535 pass`,
 * ` 0 fail`, ` 2 skip`, ` 1 todo`, one per line, which replaces the sum.
 */
const bunLine = readWith([
  // The file whose tests follow (printed once passing tests are listed).
  [/^(\S+[._-](?:test|spec)\.[cm]?[jt]sx?):$/, (c, m) => c.enterFile(m[1])],
  [
    /^\s*(\d+) (pass|fail|skip|todo)$/,
    (c, m) => {
      const n = Number(m[1]);
      if (m[2] === 'pass') c.summary({ passed: n });
      else if (m[2] === 'fail') c.summary({ failed: n });
      else if (m[2] === 'skip') c.summary({ skipped: n });
      // `todo` comes after `skip`, and counts as skipped too.
      else c.counts.skipped += n;
    },
  ],
  [
    /^\((pass|fail|skip|todo)\) (.+?)(?: \[([\d.]+)(ms|s)\])?$/,
    (c, m) => {
      c.test(stateOf(m[1]), m[2], {
        current: m[2],
        durationMs: m[3] ? Number(m[3]) * (m[4] === 's' ? 1000 : 1) : undefined,
      });
      if (m[1] === 'fail') c.failFromLastError(m[2]);
      else c.resetLastError();
    },
  ],
]);

/**
 * jest prints `PASS src/a.test.ts` / `FAIL …` per file, a `● suite › name`
 * heading per failure, and `Tests:  1 failed, 2 skipped, 10 passed, 13 total`.
 */
const jestLine = readWith([
  [
    /^\s*(PASS|FAIL)\s+(\S+\.\w+)(?:\s+\([\d.]+ m?s\))?$/,
    (c, m) => {
      c.counts.current = m[2];
      c.fileDone(m[2], { status: m[1] === 'PASS' ? 'passed' : 'failed' });
    },
  ],
  [/^\s*● Test suite failed to run$/, () => {}],
  [/^\s*● (.+ › .+|[^:]+)$/, (c, m) => c.fail({ name: m[1].trim() }, true)],
  [/^\s*Tests:\s+(.+) total$/, (c, m) => summaryTotals(c, m[1])],
]);

/**
 * playwright's list reporter: `  ✓  1 [chromium] › a.spec.ts:3:1 › title (1.2s)`
 * (`✘` failed, `-` skipped), a `1) [chromium] › a.spec.ts:3:5 › title ───`
 * heading per failure, and summary lines `3 passed (5.1s)`, `1 failed`, ….
 */
const playwrightLine = readWith([
  [
    /^\s*([✓✘-]|ok|x)\s+\d+\s+(.*›.+?)(?:\s+\([\d.]+m?s\))?$/,
    (c, m) => {
      const title = m[2].trim();
      const at = /^(?:\[[^\]]+\] › )?([^\s:]+):\d+:\d+ › (.+)$/.exec(title);
      c.test(stateOf(m[1]), at?.[2] ?? title, { file: at?.[1], current: title });
    },
  ],
  [
    /^\s*\d+\) (?:\[[^\]]+\] › )?(\S+?):(\d+):\d+ › (.+?)\s*[─]*$/,
    (c, m) => c.fail({ name: m[3], file: m[1], line: Number(m[2]) }, true),
  ],
  [
    /^\s*(\d+) (passed|failed|skipped|flaky|did not run)(?: \(.+\))?$/,
    (c, m) => {
      const field = m[2] === 'flaky' ? 'passed' : m[2] === 'did not run' ? 'skipped' : m[2];
      c.summary({ [field as TestState]: Number(m[1]) });
    },
  ],
]);

/** The latest failure whose location is still unknown (pytest's traceback order). */
const openFailure = (c: Counter) =>
  [...c.counts.failures].reverse().find((f) => f.line === undefined);

/**
 * pytest: progress lines `tests/test_a.py ..F.s  [ 40%]`, verbose lines
 * `tests/test_a.py::test_x PASSED`, a traceback per failure (`____ Class.test
 * ____`, `E  message` lines, `tests/test_a.py:61: AssertionError`), short-
 * summary `FAILED path::name - msg`, and `==== 2 failed, 10 passed in 1.23s ====`.
 */
const pytestLine = readWith([
  [
    /^(\S+\.py) ([.FsExX]+)\s*(?:\[\s*\d+%\])?$/,
    (c, m) => {
      for (const ch of m[2])
        c.test(ch === 'x' ? 'skipped' : stateOf(ch), undefined, { file: m[1] });
      c.counts.current = m[1];
    },
  ],
  [
    /^(\S+\.py)::(\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/,
    (c, m) => c.test(stateOf(m[3]), m[2], { file: m[1], current: `${m[1]}::${m[2]}` }),
  ],
  [
    /^(?:FAILED|ERROR) (\S+\.py)::(\S+)(?: - (.+))?$/,
    (c, m) => c.fail({ name: m[2], file: m[1], ...withMessage(m[3]) }, false),
  ],
  [/^_{3,} (\S+) _{3,}$/, (c, m) => c.fail({ name: m[1].replace(/\./g, '::') }, false)],
  [
    /^E\s+(\S.*)$/,
    (c, m) => {
      const failure = openFailure(c);
      if (failure && !failure.message) failure.message = m[1].slice(0, MESSAGE_MAX);
    },
  ],
  [
    /^(\S+\.py):(\d+): \w+/,
    (c, m) => {
      const failure = openFailure(c);
      if (failure && (!failure.file || failure.file === m[1])) {
        Object.assign(failure, { file: m[1], line: Number(m[2]) });
      }
    },
  ],
  [
    /^=+ (.*\b(?:passed|failed|skipped|error|errors|no tests ran)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/,
    (c, m) =>
      summaryTotals(c, m[1], { passed: ['xpassed'], failed: ['errors?'], skipped: ['xfailed'] }),
  ],
]);

/**
 * cargo test prints `test path::name ... ok` / `FAILED` / `ignored`, per
 * binary `test result: ok. 5 passed; 0 failed; 1 ignored; …`, and for a
 * failure `thread 'path::name' panicked at src/lib.rs:10:5:` then the message.
 */
const cargoLine = readWith([
  [/^test result:/, (c) => (c.counts.summarized = true)],
  [
    /^test (\S+) \.\.\. (ok|FAILED|ignored)/,
    (c, m) => {
      const state = m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped';
      c.test(state, m[1], { current: m[1] });
      if (m[2] === 'FAILED') c.fail({ name: m[1] }, false);
    },
  ],
  [
    /^thread '([^']+)' panicked at (\S+?):(\d+):\d+:?$/,
    (c, m) => c.fail({ name: m[1], file: m[2], line: Number(m[3]) }, true),
  ],
]);

/**
 * go test -v: `--- PASS: TestX (0.00s)` / `--- FAIL:` / `--- SKIP:`, the
 * failure's `    a_test.go:12: message` right after, and `ok  pkg 0.1s` /
 * `FAIL\tpkg 0.1s` per package.
 */
const goLine = readWith([
  [
    /^\s*--- (PASS|FAIL|SKIP): (\S+)/,
    (c, m) => {
      c.test(stateOf(m[1]), m[2], { current: m[2] });
      if (m[1] === 'FAIL') c.fail({ name: m[2] }, false);
    },
  ],
  [
    /^\s+(\S+_test\.go):(\d+): (.+)$/,
    (c, m) => {
      const open = [...c.counts.failures].reverse().find((f) => !f.file);
      if (open) Object.assign(open, { file: m[1], line: Number(m[2]), ...withMessage(m[3]) });
    },
  ],
  [
    /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\))/,
    (c, m) => {
      c.counts.current = m[2];
      c.namePackage(m[2], m[1] === 'ok' ? 'passed' : 'failed');
      c.counts.summarized = true;
    },
  ],
]);

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
      c.test(event.state, event.name, { file: event.file, durationMs: event.ms });
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
      c.fileDone(event.file, { durationMs: event.ms });
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
