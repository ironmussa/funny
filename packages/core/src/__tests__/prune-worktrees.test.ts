/**
 * Integration tests for pruneOrphanWorktrees.
 * Creates a real git repo and worktrees, then tests cleanup.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { executeSync } from '../git/process.js';
import { createWorktree, pruneOrphanWorktrees, getWorktreeBasePath } from '../git/worktree.js';

const TMP = resolve(tmpdir(), 'core-prune-wt-test-' + Date.now());

function initTestRepo(): string {
  const repoPath = resolve(TMP, 'project');
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  writeFileSync(resolve(repoPath, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: repoPath });
  executeSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
}

describe('pruneOrphanWorktrees', () => {
  let repoPath: string;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('returns 0 when no worktree base directory exists', async () => {
    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned.isOk()).toBe(true);
    expect(pruned._unsafeUnwrap()).toBe(0);
  });

  test('returns 0 when all worktrees are registered', async () => {
    const result = await createWorktree(repoPath, 'test-branch-1');
    expect(result.isOk()).toBe(true);

    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned.isOk()).toBe(true);
    expect(pruned._unsafeUnwrap()).toBe(0);
  });

  test('removes orphan directories not registered with git', async () => {
    // Create a legit worktree first to establish the base directory
    const result = await createWorktree(repoPath, 'legit-branch');
    expect(result.isOk()).toBe(true);

    // Create an orphan directory in the worktree base
    const base = getWorktreeBasePath(repoPath);
    const orphanPath = resolve(base, 'orphan-worktree');
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(resolve(orphanPath, 'dummy.txt'), 'stale');
    expect(existsSync(orphanPath)).toBe(true);

    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned.isOk()).toBe(true);
    expect(pruned._unsafeUnwrap()).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
  });

  test('does not remove registered worktree directories', async () => {
    const result = await createWorktree(repoPath, 'keep-this-branch');
    expect(result.isOk()).toBe(true);
    const wtPath = result._unsafeUnwrap();

    expect(existsSync(wtPath)).toBe(true);

    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned.isOk()).toBe(true);
    expect(pruned._unsafeUnwrap()).toBe(0);
    expect(existsSync(wtPath)).toBe(true);
  });

  test('handles multiple orphans', async () => {
    // Create base dir by creating a legit worktree
    const result = await createWorktree(repoPath, 'real-branch');
    expect(result.isOk()).toBe(true);

    const base = getWorktreeBasePath(repoPath);

    // Create 3 orphan directories
    for (let i = 0; i < 3; i++) {
      const orphan = resolve(base, `orphan-${i}`);
      mkdirSync(orphan, { recursive: true });
      writeFileSync(resolve(orphan, 'file.txt'), `orphan ${i}`);
    }

    const pruned = await pruneOrphanWorktrees(repoPath);
    expect(pruned.isOk()).toBe(true);
    expect(pruned._unsafeUnwrap()).toBe(3);

    for (let i = 0; i < 3; i++) {
      expect(existsSync(resolve(base, `orphan-${i}`))).toBe(false);
    }
  });
});
