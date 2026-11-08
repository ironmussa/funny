// listWorktrees: the gitoxide path must match `git worktree list`, and a
// failed listing must never make pruneOrphanWorktrees delete live worktrees.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getNativeGit } from '../git/native.js';
import { executeSync } from '../git/process.js';
import {
  createWorktree,
  listWorktrees,
  parseWorktreeListPorcelain,
  pruneOrphanWorktrees,
} from '../git/worktree.js';

const nativeAvailable = getNativeGit() !== null;
const TMP = resolve(tmpdir(), 'core-worktree-list-' + Date.now());

function initRepo(): string {
  const repoPath = resolve(TMP, 'project');
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init', '-b', 'master'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  executeSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

async function list(repoPath: string, mode: 'cli' | 'native') {
  if (mode === 'cli') process.env.FUNNY_DISABLE_NATIVE_GIT = '1';
  try {
    const result = await listWorktrees(repoPath);
    if (result.isErr()) throw new Error(result.error.message);
    return result.value.map(({ path, branch, commit, isMain }) => ({
      path,
      branch,
      commit,
      isMain,
    }));
  } finally {
    delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  }
}

let repoPath: string;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  repoPath = initRepo();
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test('parseWorktreeListPorcelain reads branch, detached and prunable entries', () => {
  const output = [
    'worktree /r',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /r-d',
    'HEAD bbb',
    'detached',
    '',
    'worktree /r-gone',
    'HEAD ccc',
    'branch refs/heads/feat/x',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  expect(parseWorktreeListPorcelain(output)).toEqual([
    { path: '/r', commit: 'aaa', branch: 'main' },
    { path: '/r-d', commit: 'bbb' },
    { path: '/r-gone', commit: 'ccc', branch: 'feat/x' },
  ]);
});

describe.skipIf(!nativeAvailable)('listWorktrees native vs CLI', () => {
  test('matches for branch, detached and deleted worktrees', async () => {
    const wa = resolve(TMP, 'wa');
    const wd = resolve(TMP, 'wd');
    const gone = resolve(TMP, 'gone');
    executeSync('git', ['worktree', 'add', '-b', 'feat/a', wa], { cwd: repoPath });
    executeSync('git', ['worktree', 'add', '--detach', wd], { cwd: repoPath });
    executeSync('git', ['worktree', 'add', '-b', 'g', gone], { cwd: repoPath });
    rmSync(gone, { recursive: true, force: true });

    const native = await list(repoPath, 'native');
    expect(native).toEqual(await list(repoPath, 'cli'));
    // Main first, then linked worktrees by path (gone < wa < wd).
    expect(native.map((w) => w.branch)).toEqual(['master', 'g', 'feat/a', undefined]);
    expect(native.filter((w) => w.isMain)).toHaveLength(1);
  });
});

test('pruneOrphanWorktrees deletes nothing when the worktree list cannot be read', async () => {
  const created = await createWorktree(repoPath, 'live-branch');
  expect(created.isOk()).toBe(true);
  const livePath = created._unsafeUnwrap();
  writeFileSync(resolve(livePath, 'work.txt'), 'uncommitted agent work\n');

  // Break the repository so neither gitoxide nor the git CLI can list worktrees.
  renameSync(resolve(repoPath, '.git', 'objects'), resolve(repoPath, '.git', 'objects.moved'));

  const pruned = await pruneOrphanWorktrees(repoPath);
  expect(pruned._unsafeUnwrap()).toBe(0);
  expect(existsSync(resolve(livePath, 'work.txt'))).toBe(true);
});
