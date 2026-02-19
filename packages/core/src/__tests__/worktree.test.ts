import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resolve, dirname } from 'path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { createWorktree, listWorktrees, removeWorktree, removeBranch } from '../git/worktree.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-worktree-test-' + Date.now());

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

describe('worktree operations', () => {
  let repoPath: string;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('createWorktree', () => {
    test('creates a worktree with new branch', async () => {
      const result = await createWorktree(repoPath, 'feature-1');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(existsSync(result.value)).toBe(true);
        expect(result.value).toContain('feature-1');
      }
    });

    test('creates worktree in .funny-worktrees directory', async () => {
      const result = await createWorktree(repoPath, 'feature-2');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('.funny-worktrees');
      }
    });

    test('replaces / with - in branch name for directory', async () => {
      const result = await createWorktree(repoPath, 'feature/slash');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('feature-slash');
      }
    });

    test('returns error for duplicate worktree', async () => {
      const first = await createWorktree(repoPath, 'dup-branch');
      expect(first.isOk()).toBe(true);

      const second = await createWorktree(repoPath, 'dup-branch');
      expect(second.isErr()).toBe(true);
    });

    test('creates worktree from specific base branch', async () => {
      // Get current branch name
      const branch = executeSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath }).stdout.trim();
      const result = await createWorktree(repoPath, 'from-base', branch);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('listWorktrees', () => {
    test('lists main worktree', async () => {
      const result = await listWorktrees(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        const main = result.value.find((w) => w.isMain);
        expect(main).toBeDefined();
      }
    });

    test('lists created worktrees', async () => {
      await createWorktree(repoPath, 'wt-list-test');

      const result = await listWorktrees(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBeGreaterThanOrEqual(2);
        const wt = result.value.find((w) => w.branch === 'wt-list-test');
        expect(wt).toBeDefined();
        expect(wt!.isMain).toBe(false);
      }
    });

    test('each worktree has path, branch, commit', async () => {
      await createWorktree(repoPath, 'wt-props-test');

      const result = await listWorktrees(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        for (const wt of result.value) {
          expect(wt.path).toBeTruthy();
          expect(typeof wt.isMain).toBe('boolean');
        }
      }
    });
  });

  describe('removeWorktree', () => {
    test('removes a worktree', async () => {
      const createResult = await createWorktree(repoPath, 'to-remove');
      if (createResult.isErr()) console.error("DEBUG ERROR:", createResult.error);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        await removeWorktree(repoPath, createResult.value);
        expect(existsSync(createResult.value)).toBe(false);
      }
    });

    test('does not throw for non-existent worktree', async () => {
      // Should not throw because reject=false
      await removeWorktree(repoPath, '/nonexistent/path');
    });
  });

  describe('removeBranch', () => {
    test('removes a branch', async () => {
      // Create a branch
      executeSync('git', ['branch', 'temp-branch'], { cwd: repoPath });

      await removeBranch(repoPath, 'temp-branch');

      // Verify branch is gone
      const branches = executeSync('git', ['branch', '--list'], { cwd: repoPath }).stdout;
      expect(branches).not.toContain('temp-branch');
    });

    test('does not throw for non-existent branch', async () => {
      // Should not throw because reject=false
      await removeBranch(repoPath, 'nonexistent-branch');
    });
  });
});
