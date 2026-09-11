import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import type { ProjectSearchProvider } from '../../services/project-search-provider.js';
import { TgrepContentSearch } from '../../services/tgrep-content-search.js';
import { createTgrepProjectSearchProvider } from '../../services/tgrep-project-search-provider.js';

// Opt in with a locally installed, pinned binary; ordinary tests never download one.
const binary = process.env.FUNNY_TGREP_TEST_BINARY;
test.skipIf(!binary)(
  'real tgrep isolates worktrees and removes owned state on rescan/disposal',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'funny-tgrep-smoke-'));
    const main = join(root, 'main');
    const branch = join(root, 'branch');
    const state = join(root, 'state');
    const clients: TgrepContentSearch[] = [];
    let provider: ProjectSearchProvider | undefined;
    const client = (cwd: string) => {
      const value = new TgrepContentSearch(cwd, binary!, state);
      clients.push(value);
      return value;
    };
    try {
      await mkdir(main);
      execFileSync('git', ['init', '-q', main]);
      execFileSync('git', [
        '-C',
        main,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ]);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'fixture', branch]);
      await writeFile(join(main, 'sample.txt'), 'café hello\nÉclair\nhelloWorld\n');
      await writeFile(join(branch, 'sample.txt'), 'branch_only\n');
      await writeFile(join(main, 'bounded.txt'), 'bounded\n'.repeat(10_002));
      const a = client(main);
      const b = client(branch);
      const result = await a.search({ query: 'hello', wholeWord: true });
      expect(result.files).toEqual([
        {
          path: 'sample.txt',
          matches: [{ line: 1, text: 'café hello', ranges: [{ start: 6, end: 11 }] }],
        },
      ]);
      const capped = await a.search({ query: 'hello', maxResults: 1 });
      expect(capped.totalMatches).toBe(1);
      expect(capped.truncated).toBe(true);
      expect(capped.files.flatMap((file) => file.matches)).toHaveLength(1);
      expect((await b.search({ query: 'hello' })).totalMatches).toBe(0);
      expect((await b.search({ query: 'branch_only' })).totalMatches).toBe(1);
      expect((await a.search({ query: 'hello', exclude: '*.txt' })).totalMatches).toBe(0);
      expect((await a.search({ query: 'hello$', regex: true })).totalMatches).toBe(1);
      // tgrep 1.0.5 does not fold accented uppercase characters in literal searches.
      expect((await a.search({ query: 'éclair' })).totalMatches).toBe(0);
      expect((await a.search({ query: 'Éclair' })).totalMatches).toBe(1);
      await expect(a.search({ query: '[', regex: true })).rejects.toThrow('protocol');
      provider = (
        await createTgrepProjectSearchProvider(main, {
          stateDir: state,
          binary,
          refreshIntervalMs: false,
          createSearch: () => client(main),
        })
      )._unsafeUnwrap();
      const defaultLimit = (await provider.searchText({ query: 'bounded' }))._unsafeUnwrap();
      expect(defaultLimit.totalMatches).toBe(1_000);
      expect(defaultLimit.truncated).toBe(true);
      const maximum = (
        await provider.searchText({ query: 'bounded', maxResults: 20_000 })
      )._unsafeUnwrap();
      expect(maximum.totalMatches).toBe(10_000);
      expect(maximum.truncated).toBe(true);
      const before = await readdir(state);
      const pids: number[] = [];
      for (const dir of before) {
        const info = await readFile(join(state, dir, 'serve.json'), 'utf8');
        // Test-only fixture metadata, never application input.
        pids.push(Number(/"pid"\s*:\s*(\d+)/.exec(info)![1]));
      }
      await provider.rescan();
      await vi.waitFor(async () => expect(await readdir(state)).toHaveLength(2));
      await provider.searchText({ query: 'hello', wholeWord: true });
      const after = await readdir(state);
      expect(after.filter((dir) => !before.includes(dir))).toHaveLength(1);
      provider.dispose();
      clients.forEach((value) => value.dispose());
      await vi.waitFor(async () => expect(await readdir(state)).toEqual([]));
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      const cancelled = client(main);
      const pending = cancelled.search({ query: 'hello' });
      cancelled.dispose();
      await expect(pending).rejects.toThrow();
      await vi.waitFor(async () => expect(await readdir(state)).toEqual([]));
    } finally {
      provider?.dispose();
      clients.forEach((value) => value.dispose());
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
