import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOutputParser, TEST_EVENT_PREFIX } from '../../packages/shared/src/checks';
import { parseTestProgress } from '../../packages/shared/src/test-progress';
import { discoverPackages, runTests } from '../run-tests';
import { ProgressFile } from '../test-progress';

const feed = (lines: string[]) => {
  const parse = createOutputParser();
  return lines.map(parse).at(-1);
};

describe('createOutputParser', () => {
  test('vitest file lines add up, and the final summary replaces the sum', () => {
    const lines = [
      ' ✓ |unit| src/a.test.ts (5 tests) 120ms',
      ' ❯ src/b.test.tsx (4 tests | 1 failed) 80ms',
      ' ↓ src/c.test.ts (3 tests | 3 skipped)',
    ];
    expect(feed(lines)).toMatchObject({
      passed: 8,
      failed: 1,
      skipped: 3,
      current: 'src/c.test.ts',
    });
    expect(
      feed([...lines, '      Tests  1193 passed | 2 failed | 6 skipped (1201)']),
    ).toMatchObject({ passed: 1193, failed: 2, skipped: 6 });
  });

  test('ANSI colors do not hide vitest lines', () => {
    expect(
      feed(['\u001B[32m ✓\u001B[39m src/a.test.ts \u001B[2m(2 tests)\u001B[22m 3ms']),
    ).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      current: 'src/a.test.ts',
    });
  });

  test('bun test pass, fail, skip and todo lines', () => {
    expect(
      feed(['(pass) a > works [0.49ms]', '(fail) a > breaks [1.20ms]', '(skip) b', '(todo) c']),
    ).toMatchObject({ passed: 1, failed: 1, skipped: 2, current: 'c' });
  });

  test('bun test summary lines set the totals', () => {
    expect(
      feed([
        'bun test v1.4.3',
        '',
        ' 535 pass',
        ' 2 skip',
        ' 1 todo',
        ' 0 fail',
        '1450 expect() calls',
      ]),
    ).toMatchObject({ passed: 535, failed: 0, skipped: 3 });
  });

  test('cargo test lines', () => {
    expect(
      feed([
        'test grpc::a ... ok',
        'test grpc::b ... FAILED',
        'test grpc::c ... ignored',
        'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured',
      ]),
    ).toMatchObject({ passed: 1, failed: 1, skipped: 1, current: 'grpc::c' });
  });

  test('reporter events give files, running files and slow entries', () => {
    let clock = 100;
    const parse = createOutputParser(() => clock);
    const event = (body: object) => parse(`${TEST_EVENT_PREFIX}${JSON.stringify(body)}`);
    event({ e: 'run', files: 3 });
    event({ e: 'file', file: 'src/a.test.ts' });
    clock = 200;
    event({ e: 'file', file: 'src/b.test.ts' });
    event({ e: 'test', file: 'src/a.test.ts', name: 'a > fast', state: 'passed', ms: 3 });
    event({ e: 'test', file: 'src/a.test.ts', name: 'a > slow', state: 'failed', ms: 12_000 });
    event({ e: 'test', file: 'src/a.test.ts', name: 'a > later', state: 'skipped', ms: 0 });
    const counts = event({ e: 'file-end', file: 'src/a.test.ts', ms: 15_000 });

    expect(counts).toMatchObject({ passed: 1, failed: 1, skipped: 1, filesTotal: 3, filesDone: 1 });
    expect(counts.running).toEqual([{ file: 'src/b.test.ts', startedAt: 200 }]);
    expect(counts.slow).toEqual([
      { kind: 'file', name: 'src/a.test.ts', durationMs: 15_000 },
      { kind: 'test', name: 'src/a.test.ts › a > slow', durationMs: 12_000 },
    ]);
  });

  test('with reporter events, vitest file lines are not counted twice', () => {
    const event = (body: object) => `${TEST_EVENT_PREFIX}${JSON.stringify(body)}`;
    expect(
      feed([
        event({ e: 'test', file: 'src/a.test.ts', name: 'x', state: 'passed', ms: 1 }),
        event({ e: 'test', file: 'src/a.test.ts', name: 'y', state: 'passed', ms: 1 }),
        ' ✓ src/a.test.ts (2 tests) 3ms',
      ]),
    ).toMatchObject({ passed: 2 });
  });

  test('a malformed event line is ignored', () => {
    expect(feed([`${TEST_EVENT_PREFIX}{not json`])).toMatchObject({ passed: 0, running: [] });
  });

  test('other output changes nothing', () => {
    expect(feed(['$ vitest run', 'Not implemented: HTMLCanvasElement'])).toMatchObject({
      passed: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-progress-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (path: string) => {
  const parsed = parseTestProgress(readFileSync(path, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe('ProgressFile', () => {
  test('writes a valid file at once and on close, and throttles reports in between', () => {
    let clock = 1_000;
    const path = join(dir, 'progress.json');
    const file = new ProgressFile(path, [{ name: '@x/a', related: true }], {
      concurrency: 4,
      intervalMs: 500,
      now: () => clock,
    });
    expect(read(path)).toMatchObject({ status: 'running', startedAt: 1_000, concurrency: 4 });
    expect(read(path).suites[0]).toMatchObject({ name: '@x/a', status: 'queued', related: true });

    clock = 1_100;
    file.start(0); // within the interval: deferred
    expect(read(path).suites[0].status).toBe('queued');

    clock = 1_700;
    file.report(0, {
      passed: 3,
      failed: 0,
      skipped: 1,
      current: 'src/a.test.ts',
      running: [],
      slow: [],
    });
    file.finish(0, 1, 600);
    file.close(1);
    expect(read(path)).toMatchObject({ status: 'failed', finishedAt: 1_700 });
    expect(read(path).suites[0]).toMatchObject({
      status: 'failed',
      passed: 3,
      skipped: 1,
      durationMs: 600,
      current: 'src/a.test.ts',
    });
  });
});

describe('runTests with a progress file', () => {
  test('adds the progress reporter to a vitest suite and reads its events', async () => {
    // A fake `vitest` that records its arguments and prints reporter events.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const args = join(dir, 'vitest-args');
    const events = [
      { e: 'run', files: 2 },
      { e: 'file', file: 'src/a.test.ts' },
      { e: 'test', file: 'src/a.test.ts', name: 'works', state: 'passed', ms: 1 },
      { e: 'file-end', file: 'src/a.test.ts', ms: 2 },
    ].map((event) => `echo '${TEST_EVENT_PREFIX}${JSON.stringify(event)}'`);
    writeFileSync(
      join(dir, 'node_modules', '.bin', 'vitest'),
      ['#!/bin/sh', `echo "$@" > '${args}'`, ...events].join('\n'),
      { mode: 0o755 },
    );
    mkdirSync(join(dir, 'packages', 'web'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { test: 'vitest run --project unit' } }),
    );
    const path = join(dir, 'progress.json');

    expect(await runTests(discoverPackages(dir), dir, 1, path)).toBe(0);
    expect(readFileSync(args, 'utf8')).toMatch(
      /^run --reporter=default --reporter=\S*vitest-progress-reporter\.mjs --project unit/,
    );
    expect(read(path).suites[0]).toMatchObject({ passed: 1, filesTotal: 2, filesDone: 1 });
  });

  test('records each suite from its output', async () => {
    const pkg = (name: string, script: string) => {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(
        join(dir, 'packages', name, 'package.json'),
        JSON.stringify({ name: `@x/${name}`, scripts: { test: script } }),
      );
    };
    pkg('ok', `printf '(pass) one\\n(pass) two\\n(skip) three\\n'`);
    pkg(
      'bad',
      `printf ' ✓ src/a.test.ts (2 tests) 1ms\\n ❯ src/b.test.ts (1 test | 1 failed)\\n'; exit 1`,
    );
    const path = join(dir, 'progress.json');

    expect(await runTests(discoverPackages(dir), dir, 2, path)).toBe(1);
    const progress = read(path);
    expect(progress.status).toBe('failed');
    expect(progress.suites).toEqual([
      expect.objectContaining({ name: '@x/bad', status: 'failed', passed: 2, failed: 1 }),
      expect.objectContaining({ name: '@x/ok', status: 'passed', passed: 2, skipped: 1 }),
    ]);
  });
});
