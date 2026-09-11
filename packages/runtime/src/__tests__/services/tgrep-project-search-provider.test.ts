import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ProjectSearchProvider,
  ProjectTextSearchResult,
} from '../../services/project-search-provider.js';
import { createTgrepProjectSearchProvider } from '../../services/tgrep-project-search-provider.js';

const empty: ProjectTextSearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false,
  durationMs: 1,
};
let root: string;
const providers: ProjectSearchProvider[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'funny-tgrep-provider-'));
});
afterEach(() => {
  providers.splice(0).forEach((provider) => provider.dispose());
  rmSync(root, { recursive: true, force: true });
});
async function create(
  createSearch = () => ({ search: vi.fn(async () => empty), dispose: vi.fn() }),
) {
  const provider = (
    await createTgrepProjectSearchProvider(root, {
      stateDir: join(root, '.state'),
      refreshIntervalMs: false,
      createSearch,
    })
  )._unsafeUnwrap();
  providers.push(provider);
  return provider;
}

describe('tgrep project search provider', () => {
  test('lists Git paths, respects ignores, ranks and caps file matches', async () => {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'search.ts'), '');
    writeFileSync(join(root, 'search.ts'), '');
    writeFileSync(join(root, 'ignored.ts'), '');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    const provider = await create();
    expect(provider.listFiles()._unsafeUnwrap()).toEqual([
      '.gitignore',
      'search.ts',
      'src/search.ts',
    ]);
    const result = provider.searchFiles('search', 1)._unsafeUnwrap();
    expect(result.matches[0].path).toBe('search.ts');
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(provider.searchFiles('SEARCH', 10)._unsafeUnwrap().total).toBe(0);
  });

  test('supports scratch directories and refreshes created and deleted files', async () => {
    writeFileSync(join(root, 'before.txt'), '');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'excluded.txt'), '');
    const provider = await create();
    const version = provider.version;
    expect(provider.listFiles()._unsafeUnwrap()).toEqual(['before.txt']);
    rmSync(join(root, 'before.txt'));
    writeFileSync(join(root, 'after.txt'), '');
    provider.refreshGitStatus();
    await vi.waitFor(() => expect(provider.listFiles()._unsafeUnwrap()).toEqual(['after.txt']));
    expect(provider.version).toBeGreaterThan(version);
  });

  test('starts content search lazily and returns its results', async () => {
    const search = vi.fn(async () => empty);
    const factory = vi.fn(() => ({ search, dispose: vi.fn() }));
    const provider = await create(factory);
    expect(factory).not.toHaveBeenCalled();
    const options = { query: 'needle', include: '*.ts', wholeWord: true, maxResults: 2 };
    expect((await provider.searchText(options))._unsafeUnwrap()).toBe(empty);
    expect(search).toHaveBeenCalledWith(options);
    expect(provider.health().available).toBe(true);
  });

  test('returns explicit content errors, keeps file search usable and retries with a new client', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('private details'))
      .mockResolvedValue(empty);
    const dispose = vi.fn();
    const factory = vi.fn(() => ({ search, dispose }));
    const provider = await create(factory);
    const failure = await provider.searchText({ query: 'needle' });
    expect(failure._unsafeUnwrapErr().message).toBe('tgrep content search unavailable');
    expect(provider.health().scanState).toBe('failed');
    expect(provider.listFiles().isOk()).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect((await provider.searchText({ query: 'retry' })).isOk()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test.each(['rescan', 'dispose'] as const)('rejects stale results after %s', async (action) => {
    let resolve!: (result: ProjectTextSearchResult) => void;
    const search = vi.fn(
      () =>
        new Promise<ProjectTextSearchResult>((done) => {
          resolve = done;
        }),
    );
    const dispose = vi.fn();
    const provider = await create(() => ({ search, dispose }));
    const pending = provider.searchText({ query: 'old' });
    await provider[action]();
    resolve(empty);
    expect((await pending).isErr()).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('rejects blank queries and operations after disposal', async () => {
    const factory = vi.fn();
    const provider = await create(factory);
    expect((await provider.searchText({ query: ' ' })).isErr()).toBe(true);
    provider.dispose();
    expect((await provider.searchText({ query: 'needle' })).isErr()).toBe(true);
    expect(provider.listFiles().isErr()).toBe(true);
    expect((await provider.rescan()).isErr()).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });
});
