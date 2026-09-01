import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileFinder, type FileFinderApi } from '@ff-labs/fff-node';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const observability = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  metric: vi.fn(),
  histogram: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: observability.info, warn: observability.warn },
}));

vi.mock('../../lib/telemetry.js', () => ({
  metric: observability.metric,
  recordHistogram: observability.histogram,
}));

import {
  createFffProjectSearchProvider,
  FffProjectSearchProvider,
} from '../../services/fff-project-search-provider.js';

let fixtureRoot: string;
let stateRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'funny-fff-provider-'));
  stateRoot = mkdtempSync(join(tmpdir(), 'funny-fff-state-'));
  mkdirSync(join(fixtureRoot, 'src', 'sub'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'ignored'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.gitignore'), 'ignored/\n');
  writeFileSync(
    join(fixtureRoot, 'src', 'one.ts'),
    ['hello Hello helloworld', 'helloworld only', 'const greeting = "hello";', ''].join('\n'),
  );
  writeFileSync(join(fixtureRoot, 'src', 'sub', 'two.md'), 'HELLO\nhello\n');
  writeFileSync(join(fixtureRoot, 'ignored', 'secret.ts'), 'hello ignored\n');
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

async function createProvider() {
  const suffix = crypto.randomUUID();
  const result = await createFffProjectSearchProvider(fixtureRoot, {
    frecencyDbPath: join(stateRoot, suffix, 'frecency'),
    historyDbPath: join(stateRoot, suffix, 'history'),
  });
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('FFF project search provider', () => {
  test('initializes, lists only indexed non-ignored files, reports health, and disposes', async () => {
    const provider = await createProvider();
    const listed = provider.listFiles();

    expect(listed.isOk()).toBe(true);
    expect(listed._unsafeUnwrap()).toEqual(
      expect.arrayContaining(['src/one.ts', 'src/sub/two.md']),
    );
    expect(listed._unsafeUnwrap()).not.toContain('ignored/secret.ts');
    expect(provider.health()).toMatchObject({
      available: true,
      scanState: 'ready',
      watcherReady: true,
    });

    provider.dispose();
    provider.dispose();
    expect(provider.health()).toMatchObject({ available: false, scanState: 'disposed' });
  });

  test('returns capped ranked file results using Funny-owned response types', async () => {
    const provider = await createProvider();
    const result = provider.searchFiles('one', 1);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      matches: [{ path: 'src/one.ts', indices: expect.any(Array), score: expect.any(Number) }],
      truncated: true,
      indexedFiles: 2,
    });
    expect(result._unsafeUnwrap().matches).toHaveLength(1);
    provider.dispose();
  });

  test('preserves plain, regex, case, whole-word, include, exclude, range, and cap semantics', async () => {
    const provider = await createProvider();

    const insensitive = await provider.searchText({ query: 'hello' });
    const sensitive = await provider.searchText({ query: 'hello', caseSensitive: true });
    const smartCase = await provider.searchText({ query: 'HELLO' });
    const regex = await provider.searchText({ query: 'h(?:ello|elloworld)', regex: true });
    const literal = await provider.searchText({ query: 'h(?:ello|elloworld)' });
    const whole = await provider.searchText({ query: 'hello', wholeWord: true });
    const included = await provider.searchText({ query: 'hello', include: '*.md' });
    const excluded = await provider.searchText({ query: 'hello', exclude: 'src/sub/**' });
    const capped = await provider.searchText({ query: 'hello', maxResults: 1 });

    for (const result of [
      insensitive,
      sensitive,
      smartCase,
      regex,
      literal,
      whole,
      included,
      excluded,
      capped,
    ]) {
      expect(result.isOk()).toBe(true);
    }
    expect(insensitive._unsafeUnwrap().totalMatches).toBeGreaterThan(
      sensitive._unsafeUnwrap().totalMatches,
    );
    expect(smartCase._unsafeUnwrap().totalMatches).toBe(1);
    expect(regex._unsafeUnwrap().totalMatches).toBeGreaterThan(0);
    expect(literal._unsafeUnwrap().totalMatches).toBe(0);
    expect(whole._unsafeUnwrap().totalMatches).toBeLessThan(
      insensitive._unsafeUnwrap().totalMatches,
    );
    expect(included._unsafeUnwrap().files.map((file) => file.path)).toEqual(['src/sub/two.md']);
    expect(excluded._unsafeUnwrap().files.map((file) => file.path)).toEqual(['src/one.ts']);
    expect(capped._unsafeUnwrap()).toMatchObject({ totalMatches: 1, truncated: true });
    const firstInsensitiveMatch = insensitive._unsafeUnwrap().files[0]?.matches[0];
    expect(firstInsensitiveMatch).toMatchObject({
      line: expect.any(Number),
      text: expect.any(String),
    });
    expect(firstInsensitiveMatch?.ranges).toEqual(
      expect.arrayContaining([{ start: expect.any(Number), end: expect.any(Number) }]),
    );
    expect(
      whole
        ._unsafeUnwrap()
        .files.flatMap((file) => file.matches)
        .flatMap((match) => match.ranges),
    ).not.toContainEqual({ start: 12, end: 17 });
    provider.dispose();
  });

  test('returns a controlled invalid-regex error and remains usable', async () => {
    const provider = await createProvider();
    const invalid = await provider.searchText({ query: '[', regex: true });
    const later = await provider.searchText({ query: 'hello' });

    expect(invalid.isErr()).toBe(true);
    expect(invalid._unsafeUnwrapErr()).toMatchObject({
      type: 'BAD_REQUEST',
      message: expect.stringContaining('Invalid regular expression'),
    });
    expect(later.isOk()).toBe(true);
    provider.dispose();
  });

  test('maps native loading and initialization failures to controlled errors', async () => {
    const load = vi.spyOn(FileFinder, 'ensureLoaded').mockImplementationOnce(() => {
      throw new Error('missing native test binding');
    });
    const unavailable = await createFffProjectSearchProvider(fixtureRoot, {
      frecencyDbPath: join(stateRoot, 'load-failure', 'frecency'),
      historyDbPath: join(stateRoot, 'load-failure', 'history'),
    });
    load.mockRestore();

    expect(unavailable.isErr()).toBe(true);
    expect(unavailable._unsafeUnwrapErr()).toMatchObject({
      type: 'INTERNAL',
      message: expect.stringContaining('FFF native binding unavailable'),
    });

    const create = vi.spyOn(FileFinder, 'create').mockReturnValueOnce({
      ok: false,
      error: 'bad initialization',
    });
    const failed = await createFffProjectSearchProvider(fixtureRoot, {
      frecencyDbPath: join(stateRoot, 'init-failure', 'frecency'),
      historyDbPath: join(stateRoot, 'init-failure', 'history'),
    });
    create.mockRestore();

    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr()).toMatchObject({
      type: 'INTERNAL',
      message: expect.stringContaining('FFF initialization failed'),
    });
  });

  test('maps query failures without calling another backend', async () => {
    const finder = {
      fileSearch: vi.fn(() => ({ ok: false, error: 'native query failed' })),
      watch: vi.fn(() => ({ ok: false, error: 'watch unavailable' })),
    } as unknown as FileFinderApi;
    const provider = new FffProjectSearchProvider(fixtureRoot, finder);

    const result = provider.searchFiles('query', 10);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'INTERNAL',
      message: expect.stringContaining('native query failed'),
    });
    expect(finder.fileSearch).toHaveBeenCalledOnce();
  });

  test('tracks only explicit query selections through the native API', () => {
    const finder = {
      trackQuery: vi.fn(() => ({ ok: true, value: true })),
      watch: vi.fn(() => ({ ok: false, error: 'watch unavailable' })),
    } as unknown as FileFinderApi;
    const provider = new FffProjectSearchProvider(fixtureRoot, finder);

    const result = provider.trackSelection('flt', 'src/flowchart.ts');

    expect(result.isOk()).toBe(true);
    expect(finder.trackQuery).toHaveBeenCalledOnce();
    expect(finder.trackQuery).toHaveBeenCalledWith('flt', 'src/flowchart.ts');
  });

  test('emits content-free operation logs and metrics', async () => {
    const provider = await createProvider();
    vi.clearAllMocks();

    const privateQuery = 'PRIVATE_QUERY_TOKEN';
    const result = provider.searchFiles(privateQuery, 10);

    expect(result.isOk()).toBe(true);
    expect(observability.metric).toHaveBeenCalledWith(
      'search.fff.operations',
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          operation: 'file-search',
          status: 'ok',
          truncated: false,
        }),
      }),
    );
    expect(observability.histogram).toHaveBeenCalledWith(
      'search.fff.duration_ms',
      expect.any(Number),
      expect.objectContaining({ unit: 'ms' }),
    );
    const serialized = JSON.stringify({
      logs: observability.info.mock.calls,
      metrics: observability.metric.mock.calls,
      histograms: observability.histogram.mock.calls,
    });
    expect(serialized).not.toContain(privateQuery);
    expect(serialized).not.toContain(fixtureRoot);
    expect(serialized).not.toContain('src/one.ts');
    expect(observability.info).toHaveBeenCalledWith(
      'FFF operation completed',
      expect.objectContaining({
        cwdId: expect.stringMatching(/^[a-f0-9]{16}$/),
        operation: 'file-search',
        resultCount: 0,
        indexedCount: 2,
        truncated: false,
      }),
    );
    provider.dispose();
  });

  test('categorizes native initialization failures without logging their raw reason', async () => {
    const privateReason = 'PRIVATE_NATIVE_FAILURE_DETAIL';
    vi.spyOn(FileFinder, 'ensureLoaded').mockImplementationOnce(() => {
      throw new Error(privateReason);
    });

    const unavailable = await createFffProjectSearchProvider(fixtureRoot, {
      frecencyDbPath: join(stateRoot, 'observability-load-failure', 'frecency'),
      historyDbPath: join(stateRoot, 'observability-load-failure', 'history'),
    });

    expect(unavailable.isErr()).toBe(true);
    expect(observability.warn).toHaveBeenCalledWith(
      'FFF operation failed',
      expect.objectContaining({
        cwdId: expect.stringMatching(/^[a-f0-9]{16}$/),
        operation: 'initialization',
        status: 'error',
        errorCategory: 'native-load',
      }),
    );
    const serialized = JSON.stringify({
      logs: observability.warn.mock.calls,
      metrics: observability.metric.mock.calls,
      histograms: observability.histogram.mock.calls,
    });
    expect(serialized).not.toContain(privateReason);
    expect(serialized).not.toContain(fixtureRoot);
  });
});
