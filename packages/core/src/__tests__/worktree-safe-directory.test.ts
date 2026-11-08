/**
 * safe.directory bookkeeping: every created worktree registers itself in the
 * global git config, so removal (and a startup prune for older leftovers) must
 * take the entry out again or ~/.gitconfig grows forever.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { executeSync } from '../git/process.js';
import {
  createWorktree,
  pruneStaleWorktreeSafeDirectories,
  removeWorktree,
} from '../git/worktree.js';

const TMP = resolve(tmpdir(), `core-safe-dir-${process.pid}-${Date.now()}`);
const GLOBAL_CONFIG = resolve(TMP, 'gitconfig');

function safeDirectories(): string[] {
  const result = executeSync('git', ['config', '--global', '--get-all', 'safe.directory'], {
    reject: false,
  });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function initRepo(): string {
  const repo = resolve(TMP, 'project');
  mkdirSync(repo, { recursive: true });
  executeSync('git', ['init', '-q'], { cwd: repo });
  executeSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  executeSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(resolve(repo, 'README.md'), '# t');
  executeSync('git', ['add', '.'], { cwd: repo });
  executeSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

describe('worktree safe.directory cleanup', () => {
  let previousGlobal: string | undefined;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(GLOBAL_CONFIG, '');
    previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = GLOBAL_CONFIG;
  });

  afterEach(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    rmSync(TMP, { recursive: true, force: true });
  });

  test('removing a worktree also removes its safe.directory entry', async () => {
    const repo = initRepo();
    const worktree = (await createWorktree(repo, 'feature-a'))._unsafeUnwrap();
    expect(safeDirectories()).toContain(worktree);
    expect(safeDirectories()).toContain(repo);

    (await removeWorktree(repo, worktree))._unsafeUnwrap();

    expect(safeDirectories()).not.toContain(worktree);
    // The project itself stays trusted.
    expect(safeDirectories()).toContain(repo);
  });

  test('startup prune drops only missing worktree entries', async () => {
    const live = resolve(TMP, '.funny-worktrees', 'project', 'live');
    mkdirSync(live, { recursive: true });
    const gone = resolve(TMP, '.funny-worktrees', 'project', 'gone[1]');
    const usersOwn = resolve(TMP, 'not-a-worktree-and-missing');
    for (const dir of [live, gone, gone, usersOwn]) {
      executeSync('git', ['config', '--global', '--add', 'safe.directory', dir]);
    }

    const removed = await pruneStaleWorktreeSafeDirectories();

    expect(removed._unsafeUnwrap()).toBe(1);
    expect(safeDirectories()).toEqual([live, usersOwn]);
    expect(readFileSync(GLOBAL_CONFIG, 'utf8')).not.toContain('gone[1]');
  });

  test('prune is a no-op without any safe.directory entry', async () => {
    expect((await pruneStaleWorktreeSafeDirectories())._unsafeUnwrap()).toBe(0);
  });
});
