/**
 * The factory's cross-lane conflict check (openspec factory-lanes D7):
 * `git merge-tree` per pair of remote lane branches, writing no branch and no
 * worktree.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkBranchConflicts, parseGitVersion } from '../git/branch-conflicts.js';
import { executeSync } from '../git/process.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return executeSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
  }).stdout.trim();
}

function commitFile(cwd: string, path: string, text: string, message: string) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', message);
}

/**
 * An `origin` with `dev` and three lanes: `feature/a` and `feature/b` change
 * the same line of `src/router.ts`; `feature/c` touches another file. Returns
 * a clone that has fetched nothing but `dev`.
 */
function lanesRepo(): string {
  const origin = tempDir('funny-lanes-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'dev');

  const seed = tempDir('funny-lanes-seed-');
  git(seed, 'init', '-q', '-b', 'dev');
  commitFile(seed, 'src/router.ts', 'export const route = "home";\n', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'dev');
  for (const [branch, path, text] of [
    ['feature/a', 'src/router.ts', 'export const route = "a";\n'],
    ['feature/b', 'src/router.ts', 'export const route = "b";\n'],
    ['feature/c', 'src/other.ts', 'export const other = 1;\n'],
  ] as const) {
    git(seed, 'checkout', '-q', '-b', branch, 'dev');
    commitFile(seed, path, text, branch);
    git(seed, 'push', '-q', 'origin', branch);
  }

  const clone = tempDir('funny-lanes-clone-');
  git(clone, 'clone', '-q', '--single-branch', '--branch', 'dev', origin, '.');
  // A plain clone's refspec fetches every branch; the check relies on that.
  git(clone, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  return clone;
}

describe('checkBranchConflicts', () => {
  test('reports the pairs that conflict and their paths, and writes no branch or worktree', async () => {
    const clone = lanesRepo();
    const headsBefore = git(clone, 'for-each-ref', '--format=%(refname)', 'refs/heads');
    const worktreesBefore = git(clone, 'worktree', 'list', '--porcelain');
    const statusBefore = git(clone, 'status', '--porcelain');

    const report = await checkBranchConflicts(clone, ['feature/a', 'feature/b', 'feature/c']);

    expect(report.isOk()).toBe(true);
    const value = report._unsafeUnwrap();
    if (value.kind !== 'checked') throw new Error(`expected a check, got ${value.reason}`);
    expect(value.fetched).toBe(true);
    expect(value.missing).toEqual([]);
    expect(value.conflicts).toEqual([{ a: 'feature/a', b: 'feature/b', paths: ['src/router.ts'] }]);

    expect(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(headsBefore);
    expect(git(clone, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore);
    expect(git(clone, 'status', '--porcelain')).toBe(statusBefore);
  });

  test('leaves out a branch the remote does not have, and an unsafe ref name', async () => {
    const clone = lanesRepo();
    const report = await checkBranchConflicts(clone, ['feature/a', 'feature/gone', '--output=x']);
    const value = report._unsafeUnwrap();
    if (value.kind !== 'checked') throw new Error('expected a check');
    expect(value.missing).toEqual(['feature/gone', '--output=x']);
    expect(value.conflicts).toEqual([]);
  });
});

describe('parseGitVersion', () => {
  test('reads the major and minor version', () => {
    expect(parseGitVersion('git version 2.43.0')).toEqual([2, 43]);
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39]);
    expect(parseGitVersion('nonsense')).toBeNull();
  });
});
