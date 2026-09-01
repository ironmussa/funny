import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  createCurrentAdapter,
  createFffAdapter,
  type SearchBenchmarkAdapter,
} from '../support/search-benchmark-adapters.js';
import { createCorrectnessFixture } from '../support/search-benchmark-fixture.js';

describe('FFF comparative correctness fixture', () => {
  let root: string;
  let current: SearchBenchmarkAdapter;
  let fff: SearchBenchmarkAdapter;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'funny-search-correctness-'));
    await createCorrectnessFixture(root);
    [current, fff] = await Promise.all([
      createCurrentAdapter(root),
      createFffAdapter(root, { disableWatch: false }),
    ]);
  });

  afterAll(async () => {
    current?.destroy();
    fff?.destroy();
    await rm(root, { recursive: true, force: true });
  });

  test('respects ignores and returns typo-tolerant ranked files', () => {
    expect(fff.indexedFiles).toBeGreaterThan(0);
    expect(current.indexedFiles).toBeGreaterThanOrEqual(fff.indexedFiles);
    expect(fff.fileSearch('usr servce', 10).map((item) => item.path)).toContain(
      'src/UserService.ts',
    );
    expect(fff.fileSearch('secret', 10).map((item) => item.path)).not.toContain(
      'ignored/secret.ts',
    );
  });

  test('reports file and content readiness independently', () => {
    expect(current.fileReadyMs).toBeGreaterThanOrEqual(0);
    expect(current.contentReadyMs).toBe(current.fileReadyMs);
    expect(fff.fileReadyMs).toBeGreaterThanOrEqual(0);
    expect(fff.contentReadyMs).toBeGreaterThanOrEqual(fff.fileReadyMs);
  });

  test('lists the exact indexed corpus used by each backend', () => {
    expect(current.listIndexedFiles()).toContain('ignored/secret.ts');
    expect(fff.listIndexedFiles()).not.toContain('ignored/secret.ts');
    expect(fff.listIndexedFiles()).toContain('src/UserService.ts');
  });

  test('discovers a file created after initialization through the native watcher', async () => {
    const relativePath = 'src/WatcherDiscoveryProbe.ts';
    const contents = 'export const watcherDiscoveryProbe = "watcher content probe";\n';
    await writeFile(join(root, relativePath), contents, 'utf8');

    await expect
      .poll(() => fff.fileSearch('WatcherDiscoveryProbe', 10).map((item) => item.path), {
        timeout: 5_000,
      })
      .toContain(relativePath);
    await expect
      .poll(async () => (await fff.textSearch({ query: 'watcher content probe' })).matches, {
        timeout: 5_000,
      })
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: relativePath })]));
  }, 10_000);

  test.each([
    { name: 'plain smart case', options: { query: 'hello' } },
    { name: 'smart case uppercase', options: { query: 'Hello' } },
    { name: 'explicit case', options: { query: 'hello', caseSensitive: true } },
    { name: 'regex', options: { query: 'hello\\s+world', regex: true } },
    { name: 'whole word', options: { query: 'hello', wholeWord: true } },
    { name: 'include glob', options: { query: 'hello', include: '*.md' } },
    { name: 'exclude glob', options: { query: 'hello', exclude: '*.test.ts' } },
    {
      name: 'combined globs',
      options: { query: 'hello', include: '*.ts,*.md', exclude: '*.test.ts' },
    },
  ])('preserves $name result identities', async ({ options }) => {
    const [currentResult, fffResult] = await Promise.all([
      current.textSearch(options),
      fff.textSearch(options),
    ]);
    expect(identitySet(fffResult.matches)).toEqual(identitySet(currentResult.matches));
  });

  test('reports invalid regex instead of accepting FFF literal fallback', async () => {
    await expect(fff.textSearch({ query: '[invalid', regex: true })).rejects.toThrow(
      /Invalid regular expression/,
    );
  });

  test('preserves result caps, truncation, one-based lines, and highlight ranges', async () => {
    const [currentResult, fffResult] = await Promise.all([
      current.textSearch({ query: 'hello', maxResults: 1 }),
      fff.textSearch({ query: 'hello', maxResults: 1 }),
    ]);
    expect(fffResult).toEqual(currentResult);
    expect(fffResult.truncated).toBe(true);
    expect(fffResult.matches[0]?.line).toBeGreaterThanOrEqual(1);
    expect(fffResult.matches[0]?.ranges[0]).toEqual(
      expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
    );
  });
});

function identitySet(matches: Array<{ path: string; line: number; text: string }>): string[] {
  return matches
    .map(
      (match) =>
        `${match.path}:${match.line}:${match.text}:${JSON.stringify('ranges' in match ? match.ranges : [])}`,
    )
    .sort();
}
