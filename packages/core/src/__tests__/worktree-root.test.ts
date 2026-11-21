import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
/**
 * FUNNY_WORKTREE_ROOT: worktrees under a configured root instead of next to
 * the project. Unit tests for the base resolution, then integration tests
 * against real repos: where new worktrees go, that worktrees made before the
 * setting stay valid, and that two projects with the same name never prune
 * each other's worktrees.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, resolve } from 'path';

import { stubEnv, unstubAllEnvs } from '@funny/test-kit';

import { executeSync } from '../git/process.js';
import {
  checkWorktreePathInProject,
  configuredWorktreeRoot,
  createWorktree,
  getWorktreeBasePath,
  getWorktreeBasePaths,
  pruneOrphanWorktrees,
} from '../git/worktree.js';

describe('worktree base resolution', () => {
  test('without a root, worktrees live next to the project', () => {
    expect(getWorktreeBasePath('/code/app', {})).toBe('/code/.funny-worktrees/app');
    expect(getWorktreeBasePaths('/code/app', {})).toEqual(['/code/.funny-worktrees/app']);
  });

  test('a root puts the base under <root>/.funny-worktrees with a per-path hash', () => {
    const env = { FUNNY_WORKTREE_ROOT: '/fast' };
    const base = getWorktreeBasePath('/code/app', env);
    expect(base).toMatch(/^\/fast\/\.funny-worktrees\/app-[0-9a-f]{8}$/);
    // The sibling base stays valid for worktrees made before the setting.
    expect(getWorktreeBasePaths('/code/app', env)).toEqual([base, '/code/.funny-worktrees/app']);
  });

  test('two projects with the same name get different bases under the root', () => {
    const env = { FUNNY_WORKTREE_ROOT: '/fast' };
    expect(getWorktreeBasePath('/a/app', env)).not.toBe(getWorktreeBasePath('/b/app', env));
  });

  test('a relative or blank root is ignored; ~ expands to the home directory', () => {
    expect(configuredWorktreeRoot({ FUNNY_WORKTREE_ROOT: 'relative/dir' })).toBeNull();
    expect(configuredWorktreeRoot({ FUNNY_WORKTREE_ROOT: '   ' })).toBeNull();
    expect(configuredWorktreeRoot({ FUNNY_WORKTREE_ROOT: '~/wt' })).toBe(resolve(homedir(), 'wt'));
  });
});

const TMP = resolve(tmpdir(), `core-worktree-root-test-${Date.now()}`);

function initRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  executeSync('git', ['init'], { cwd: path });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: path });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: path });
  writeFileSync(resolve(path, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: path });
  executeSync('git', ['commit', '-m', 'initial commit'], { cwd: path });
  return path;
}

describe('worktrees under FUNNY_WORKTREE_ROOT', () => {
  const root = resolve(TMP, 'root');
  let repoPath: string;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(resolve(TMP, 'one', 'app'));
  });

  afterEach(() => {
    unstubAllEnvs();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('new worktrees are created under the root, and older sibling ones stay valid', async () => {
    const before = await createWorktree(repoPath, 'made-before');
    expect(before.isOk()).toBe(true);
    const legacyPath = before._unsafeUnwrap();
    expect(dirname(legacyPath)).toBe(resolve(TMP, 'one', '.funny-worktrees', 'app'));

    stubEnv('FUNNY_WORKTREE_ROOT', root);
    const after = await createWorktree(repoPath, 'made-after');
    expect(after.isOk()).toBe(true);
    const rootPath = after._unsafeUnwrap();
    expect(dirname(rootPath)).toBe(getWorktreeBasePath(repoPath));
    expect(rootPath.startsWith(`${root}/.funny-worktrees/`)).toBe(true);

    expect(checkWorktreePathInProject(repoPath, rootPath)).toBeNull();
    expect(checkWorktreePathInProject(repoPath, legacyPath)).toBeNull();
    // Still only direct children of a base.
    expect(checkWorktreePathInProject(repoPath, dirname(rootPath))).not.toBeNull();
  });

  test('pruning one project never removes the worktrees of a same-named project', async () => {
    stubEnv('FUNNY_WORKTREE_ROOT', root);
    const otherRepo = initRepo(resolve(TMP, 'two', 'app'));
    const other = await createWorktree(otherRepo, 'other-branch');
    expect(other.isOk()).toBe(true);
    const own = await createWorktree(repoPath, 'own-branch');
    expect(own.isOk()).toBe(true);
    const orphan = resolve(getWorktreeBasePath(repoPath), 'orphan');
    mkdirSync(orphan);

    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned._unsafeUnwrap()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(own._unsafeUnwrap())).toBe(true);
    expect(existsSync(other._unsafeUnwrap())).toBe(true);
  });
});
