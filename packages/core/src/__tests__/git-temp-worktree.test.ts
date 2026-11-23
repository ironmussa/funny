/**
 * Temporary detached worktrees for the regression proof gate:
 * create, copy files, diff, remove, sweep, and security refusals.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

import { executeSync } from '../git/process.js';
import {
  createTempWorktree,
  removeTempWorktree,
  copyFilesFromCommit,
  changedFilesBetween,
  mergeBase,
  sweepTempWorktrees,
  TEMP_WORKTREE_PREFIX,
} from '../git/temp-worktree.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return executeSync('git', args, { cwd });
}

function sourceRepo(): { path: string; baseCommit: string; headCommit: string } {
  const { mkdirSync } = require('fs') as typeof import('fs');
  const dir = tempDir('funny-proof-src-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init');

  const srcDir = join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'lib.ts'), 'export const x = 1;\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'base');

  const baseCommit = executeSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

  const testDir = join(srcDir, '__tests__');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'lib.test.ts'), 'test("x", () => expect(1).toBe(1));\n');
  const fixtureDir = join(srcDir, '__fixtures__');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'data.json'), '{"key":"value"}\n');
  writeFileSync(join(srcDir, 'lib.ts'), 'export const x = 2;\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'add test');

  const headCommit = executeSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

  return { path: dir, baseCommit, headCommit };
}

describe('createTempWorktree', () => {
  test('creates a detached worktree at the given commit', async () => {
    const repo = sourceRepo();
    const result = await createTempWorktree(repo.path, repo.baseCommit, 'base');
    expect(result.isOk()).toBe(true);
    const worktreePath = result._unsafeUnwrap();

    expect(existsSync(worktreePath)).toBe(true);
    expect(basename(worktreePath)).toMatch(new RegExp(`^${TEMP_WORKTREE_PREFIX}`));

    // HEAD is the base commit
    const head = executeSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }).stdout.trim();
    expect(head).toBe(repo.baseCommit);

    // The test file added in the head commit should NOT be present at the base
    expect(existsSync(join(worktreePath, 'src', '__tests__', 'lib.test.ts'))).toBe(false);
    expect(existsSync(join(worktreePath, 'src', 'lib.ts'))).toBe(true);

    // Cleanup
    await removeTempWorktree(repo.path, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test('refuses a ref starting with -', async () => {
    const repo = sourceRepo();
    const result = await createTempWorktree(repo.path, '--evil');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Invalid commit ref');
  });
});

describe('copyFilesFromCommit', () => {
  test('copies test files from the head commit into the base worktree', async () => {
    const repo = sourceRepo();
    const wtResult = await createTempWorktree(repo.path, repo.baseCommit, 'copy');
    expect(wtResult.isOk()).toBe(true);
    const wt = wtResult._unsafeUnwrap();

    // Before copy: test file should not exist
    expect(existsSync(join(wt, 'src', '__tests__', 'lib.test.ts'))).toBe(false);

    const copyResult = await copyFilesFromCommit(repo.path, wt, repo.headCommit, [
      'src/__tests__/lib.test.ts',
      'src/__fixtures__/data.json',
    ]);
    expect(copyResult.isOk()).toBe(true);

    // After copy: test file and fixture should exist
    expect(existsSync(join(wt, 'src', '__tests__', 'lib.test.ts'))).toBe(true);
    expect(existsSync(join(wt, 'src', '__fixtures__', 'data.json'))).toBe(true);

    // The production file should NOT have been updated (still the base version)
    const content = require('fs').readFileSync(join(wt, 'src', 'lib.ts'), 'utf8');
    expect(content).toContain('x = 1');

    await removeTempWorktree(repo.path, wt);
  });

  test('refuses a path with ..', async () => {
    const repo = sourceRepo();
    const result = await copyFilesFromCommit(repo.path, '/tmp/x', repo.headCommit, [
      '../../../etc/passwd',
    ]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Invalid file path');
  });

  test('refuses a ref starting with -', async () => {
    const repo = sourceRepo();
    const result = await copyFilesFromCommit(repo.path, '/tmp/x', '--evil', ['file.ts']);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Invalid commit ref');
  });
});

describe('changedFilesBetween', () => {
  test('returns added and modified files between two commits', async () => {
    const repo = sourceRepo();
    const result = await changedFilesBetween(repo.path, repo.baseCommit, repo.headCommit);
    expect(result.isOk()).toBe(true);
    const files = result._unsafeUnwrap();

    // Should include the new test, fixture, and modified lib
    expect(files).toContain('src/__tests__/lib.test.ts');
    expect(files).toContain('src/__fixtures__/data.json');
    expect(files).toContain('src/lib.ts');
  });

  test('refuses a hostile base ref', async () => {
    const repo = sourceRepo();
    const result = await changedFilesBetween(repo.path, '--evil', repo.headCommit);
    expect(result.isErr()).toBe(true);
  });

  test('refuses a hostile head ref', async () => {
    const repo = sourceRepo();
    const result = await changedFilesBetween(repo.path, repo.baseCommit, '--evil');
    expect(result.isErr()).toBe(true);
  });
});

describe('mergeBase', () => {
  test('returns the merge-base of two commits', async () => {
    const repo = sourceRepo();
    const result = await mergeBase(repo.path, repo.baseCommit, repo.headCommit);
    expect(result.isOk()).toBe(true);
    // The head descends from the base, so the merge-base is the base itself
    expect(result._unsafeUnwrap()).toBe(repo.baseCommit);
  });

  test('refuses a hostile ref', async () => {
    const result = await mergeBase('/tmp', '--evil', 'abc123');
    expect(result.isErr()).toBe(true);
  });
});

describe('removeTempWorktree', () => {
  test('refuses to remove a non-temp worktree', async () => {
    const result = await removeTempWorktree('/tmp', '/tmp/my-normal-worktree');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not a temp proof worktree');
  });

  test('leaves no worktree behind', async () => {
    const repo = sourceRepo();
    const wtResult = await createTempWorktree(repo.path, repo.baseCommit, 'rm');
    expect(wtResult.isOk()).toBe(true);
    const wt = wtResult._unsafeUnwrap();
    expect(existsSync(wt)).toBe(true);

    await removeTempWorktree(repo.path, wt);
    expect(existsSync(wt)).toBe(false);
  });
});

describe('sweepTempWorktrees', () => {
  test('removes leftover temp worktrees by prefix', async () => {
    const repo = sourceRepo();

    // Create a temp worktree and "abandon" it (don't remove it properly)
    const wtResult = await createTempWorktree(repo.path, repo.baseCommit, 'leftover');
    expect(wtResult.isOk()).toBe(true);
    const wt = wtResult._unsafeUnwrap();
    expect(existsSync(wt)).toBe(true);

    // Sweep should find and remove it
    const sweepResult = await sweepTempWorktrees(repo.path);
    expect(sweepResult.isOk()).toBe(true);
    expect(sweepResult._unsafeUnwrap()).toBeGreaterThanOrEqual(1);
    expect(existsSync(wt)).toBe(false);
  });

  test('returns 0 when there are no temp worktrees', async () => {
    const repo = sourceRepo();
    const result = await sweepTempWorktrees(repo.path);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(0);
  });
});
