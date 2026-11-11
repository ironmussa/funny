// Live test progress for the client's `test-progress` visualizer.
//
// `run-tests.ts` feeds each suite's output, line by line, to a parser that
// counts tests and remembers the last file or test reported (vitest suites also
// get `vitest-progress-reporter.ts`, whose event lines give per-test progress,
// the files running and the slow ones), and a
// `ProgressFile` rewrites the JSON file `FUNNY_TEST_PROGRESS` names (atomically,
// at most every `intervalMs`). The shape is `TestProgress` in
// `@funny/shared/test-progress`.

import {
  SLOW_TEST_MS,
  TEST_PROGRESS_VERSION,
  type TestProgress,
  type TestProgressSlowEntry,
  type TestProgressSuite,
} from '../packages/shared/src/test-progress';
import { openProgressFile, type ThrottledJsonFile, type ThrottleOptions } from './progress-io';

/** Starts an event line from `vitest-progress-reporter.ts`; JSON follows. */
export const TEST_EVENT_PREFIX = '##funny-test ';

/** A progress event a reporter prints after `TEST_EVENT_PREFIX`. */
export type TestEvent =
  | { e: 'run'; files: number }
  | { e: 'file'; file: string }
  | { e: 'test'; file: string; name: string; state: 'passed' | 'failed' | 'skipped'; ms: number }
  | { e: 'file-end'; file: string; ms: number };

/** Slow entries kept per suite. */
const SLOW_LIMIT = 20;

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
}

/** Feeds output lines; returns the counts seen so far. */
export type OutputParser = (line: string) => SuiteCounts;

/** ANSI color/cursor sequences: ESC `[` params final-letter. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/**
 * vitest's default reporter prints one line per finished file:
 *   ` ✓ |unit| src/a.test.ts (5 tests) 120ms`
 *   ` ❯ src/b.test.ts (4 tests | 1 failed) 80ms`
 *   ` ↓ src/c.test.ts (3 tests | 3 skipped)`
 * and a final `Tests  12 passed | 1 failed (13)`, which replaces the sum. With
 * reporter events (`fromEvents`) the file lines are skipped: the events
 * already counted those tests.
 */
function vitestLine(counts: SuiteCounts, line: string, fromEvents: boolean): void {
  const file = /^\s*[✓×❯↓]\s+(?:\|[^|]+\|\s+)?(\S+)\s+\((\d+) tests?([^)]*)\)/.exec(line);
  if (file && fromEvents) return;
  if (file) {
    const total = Number(file[2]);
    const failed = Number(/(\d+) failed/.exec(file[3])?.[1] ?? 0);
    const skipped = Number(/(\d+) skipped/.exec(file[3])?.[1] ?? 0);
    counts.passed += total - failed - skipped;
    counts.failed += failed;
    counts.skipped += skipped;
    counts.current = file[1];
    return;
  }
  const summary = /^\s*Tests\s+(.+)\(\d+\)\s*$/.exec(line);
  if (summary) {
    const count = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(summary[1])?.[1] ?? 0);
    counts.passed = count('passed');
    counts.failed = count('failed');
    counts.skipped = count('skipped') + count('todo');
  }
}

/**
 * bun test prints `(pass) name [1ms]`, `(fail) …`, `(skip) …` / `(todo) …` (on
 * a terminal, or for failures), and always a summary: ` 535 pass`, ` 0 fail`,
 * ` 2 skip`, ` 1 todo`, one per line, which replaces the sum.
 */
function bunLine(counts: SuiteCounts, line: string): void {
  const summary = /^\s*(\d+) (pass|fail|skip|todo)$/.exec(line);
  if (summary) {
    const n = Number(summary[1]);
    if (summary[2] === 'pass') counts.passed = n;
    else if (summary[2] === 'fail') counts.failed = n;
    else counts.skipped = summary[2] === 'skip' ? n : counts.skipped + n;
    return;
  }
  const test = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
  if (!test) return;
  if (test[1] === 'pass') counts.passed++;
  else if (test[1] === 'fail') counts.failed++;
  else counts.skipped++;
  counts.current = test[2];
}

/**
 * cargo test prints `test path::name ... ok` / `FAILED` / `ignored`, and per
 * test binary `test result: ok. 5 passed; 0 failed; 1 ignored; …`.
 */
function cargoLine(counts: SuiteCounts, line: string): void {
  if (line.startsWith('test result:')) return;
  const test = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line);
  if (!test) return;
  if (test[2] === 'ok') counts.passed++;
  else if (test[2] === 'FAILED') counts.failed++;
  else counts.skipped++;
  counts.current = test[1];
}

function noteSlow(counts: SuiteCounts, entry: TestProgressSlowEntry): void {
  if (entry.durationMs < SLOW_TEST_MS) return;
  counts.slow = [...counts.slow, entry]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOW_LIMIT);
}

const STATE_FIELD = { passed: 'passed', failed: 'failed', skipped: 'skipped' } as const;

function applyEvent(counts: SuiteCounts, event: TestEvent, now: number): void {
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
      noteSlow(counts, {
        kind: 'test',
        name: `${event.file} › ${event.name}`,
        durationMs: event.ms,
      });
      return;
    case 'file-end':
      counts.running = counts.running.filter((run) => run.file !== event.file);
      counts.filesDone = (counts.filesDone ?? 0) + 1;
      noteSlow(counts, { kind: 'file', name: event.file, durationMs: event.ms });
  }
}

/** The event on a reporter line, or null for any other line. */
function parseEvent(line: string): TestEvent | null {
  const at = line.indexOf(TEST_EVENT_PREFIX);
  if (at === -1) return null;
  try {
    return JSON.parse(line.slice(at + TEST_EVENT_PREFIX.length)) as TestEvent;
  } catch {
    return null;
  }
}

/** Whether a line is a reporter event (kept out of the printed output). */
export const isEventLine = (line: string) => line.includes(TEST_EVENT_PREFIX);

/**
 * A parser that understands reporter events, and vitest, bun test and cargo
 * test output alike. `now` stamps when a file started running.
 */
export function createOutputParser(now: () => number = Date.now): OutputParser {
  const counts: SuiteCounts = { passed: 0, failed: 0, skipped: 0, running: [], slow: [] };
  let fromEvents = false;
  return (raw) => {
    const event = parseEvent(raw);
    if (event) {
      fromEvents = true;
      applyEvent(counts, event, now());
    } else {
      const line = raw.replace(ANSI, '').trimEnd();
      vitestLine(counts, line, fromEvents);
      bunLine(counts, line);
      cargoLine(counts, line);
    }
    return { ...counts };
  };
}

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
    this.patch(index, counts);
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
