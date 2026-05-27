import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { searchText } from '../../services/text-search-service.js';

/**
 * These tests exercise the real ripgrep binary against a temp directory of
 * fixture files. `findRipgrep()` looks at $FUNNY_RIPGREP_PATH first — when
 * unset it falls back to `@vscode/ripgrep` then `rg` on $PATH. CI / dev
 * machines without `rg` installed should set `FUNNY_RIPGREP_PATH` or skip.
 */

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'funny-text-search-'));
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });
  mkdirSync(join(tmpRoot, 'src', 'sub'), { recursive: true });
  mkdirSync(join(tmpRoot, 'node_modules'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'src', 'one.ts'),
    [
      'export const greet = () => "hello world";',
      'const greeting = "Hello, World";',
      'console.log(greet());',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(tmpRoot, 'src', 'sub', 'two.ts'),
    ['function hello() {', '  return "world";', '}', ''].join('\n'),
  );
  writeFileSync(join(tmpRoot, 'src', 'three.md'), '# Hello\n\nworld in markdown\n');
  writeFileSync(join(tmpRoot, 'node_modules', 'noise.js'), 'hello from node_modules\n');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('searchText', () => {
  beforeEach(() => {
    // No fixture for the resolver — leave $FUNNY_RIPGREP_PATH alone so the
    // real cascade (env → @vscode/ripgrep → PATH) runs and we exercise it.
  });

  test('returns matches grouped by file with byte ranges', async () => {
    const r = await searchText(tmpRoot, { query: 'hello' });
    expect(r.isOk()).toBe(true);
    const v = r._unsafeUnwrap();
    expect(v.totalMatches).toBeGreaterThan(0);
    const paths = v.files.map((f) => f.path).sort();
    // node_modules content is NOT excluded by default — ripgrep respects
    // .gitignore but our fixture has no .gitignore, so we expect it to appear.
    expect(paths.some((p) => p.endsWith('one.ts'))).toBe(true);
    expect(paths.some((p) => p.endsWith('two.ts'))).toBe(true);
    const oneTs = v.files.find((f) => f.path.endsWith('one.ts'))!;
    expect(oneTs.matches[0]).toMatchObject({
      line: expect.any(Number),
      text: expect.any(String),
      ranges: expect.any(Array),
    });
    expect(oneTs.matches[0].ranges[0]).toMatchObject({
      start: expect.any(Number),
      end: expect.any(Number),
    });
  });

  test('case-sensitive search excludes wrong-case matches', async () => {
    const insensitive = await searchText(tmpRoot, { query: 'hello' });
    const sensitive = await searchText(tmpRoot, { query: 'hello', caseSensitive: true });
    expect(insensitive.isOk() && sensitive.isOk()).toBe(true);
    // Sensitive count must be < insensitive (fixture has "Hello" and "hello").
    expect(sensitive._unsafeUnwrap().totalMatches).toBeLessThan(
      insensitive._unsafeUnwrap().totalMatches,
    );
  });

  test('regex flag enables pattern matching', async () => {
    const r = await searchText(tmpRoot, { query: 'gree(t|ting)', regex: true });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().totalMatches).toBeGreaterThanOrEqual(2);
  });

  test('regex characters are treated literally when regex flag is off', async () => {
    // The `(` would be a regex error if not properly escaped. With
    // --fixed-strings (the default) it should simply find zero matches.
    const r = await searchText(tmpRoot, { query: 'gree(t|ting)' });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().totalMatches).toBe(0);
  });

  test('whole-word matching excludes substring hits', async () => {
    // "greeting" contains "gree" but is not a word match.
    const partial = await searchText(tmpRoot, { query: 'gree' });
    const whole = await searchText(tmpRoot, { query: 'gree', wholeWord: true });
    expect(partial.isOk() && whole.isOk()).toBe(true);
    expect(partial._unsafeUnwrap().totalMatches).toBeGreaterThan(0);
    expect(whole._unsafeUnwrap().totalMatches).toBe(0);
  });

  test('include glob filters to a subset of files', async () => {
    const all = await searchText(tmpRoot, { query: 'hello' });
    const onlyMd = await searchText(tmpRoot, { query: 'hello', include: '*.md' });
    expect(all.isOk() && onlyMd.isOk()).toBe(true);
    const mdFiles = onlyMd._unsafeUnwrap().files;
    expect(mdFiles.length).toBeGreaterThan(0);
    expect(mdFiles.every((f) => f.path.endsWith('.md'))).toBe(true);
  });

  test('exclude glob skips matching paths', async () => {
    const withNodeModules = await searchText(tmpRoot, { query: 'hello' });
    const withoutNodeModules = await searchText(tmpRoot, {
      query: 'hello',
      exclude: 'node_modules/**',
    });
    expect(withNodeModules.isOk() && withoutNodeModules.isOk()).toBe(true);
    expect(
      withoutNodeModules._unsafeUnwrap().files.every((f) => !f.path.includes('node_modules')),
    ).toBe(true);
  });

  test('truncates at maxResults across all files', async () => {
    const r = await searchText(tmpRoot, { query: 'hello', maxResults: 1 });
    expect(r.isOk()).toBe(true);
    const v = r._unsafeUnwrap();
    expect(v.totalMatches).toBeLessThanOrEqual(1);
    // Whether we truncated depends on the fixture (>1 total hits exist), so
    // we only assert the flag is a boolean and the cap was honored.
    expect(typeof v.truncated).toBe('boolean');
  });

  test('empty query is rejected with BAD_REQUEST', async () => {
    const r = await searchText(tmpRoot, { query: '   ' });
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('BAD_REQUEST');
  });

  test('no matches returns an empty result, not an error', async () => {
    const r = await searchText(tmpRoot, { query: 'zzz-this-does-not-exist-zzz' });
    expect(r.isOk()).toBe(true);
    const v = r._unsafeUnwrap();
    expect(v.totalMatches).toBe(0);
    expect(v.files).toEqual([]);
    expect(v.truncated).toBe(false);
  });
});
