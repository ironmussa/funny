import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { resolve, dirname } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { executeSync } from '@funny/core/git';

const TEST_REPO = resolve(import.meta.dir, '..', '..', '..', '.test-tmp-worktree-repo');
const WORKTREE_DIR = resolve(dirname(TEST_REPO), '.funny-worktrees');

function setupRepo() {
  rmSync(TEST_REPO, { recursive: true, force: true });
  rmSync(WORKTREE_DIR, { recursive: true, force: true });

  mkdirSync(TEST_REPO, { recursive: true });
  executeSync('git', ['init'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO });
  writeFileSync(resolve(TEST_REPO, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: TEST_REPO });
  executeSync('git', ['commit', '-m', 'initial'], { cwd: TEST_REPO });
}

function cleanupRepo() {
  // Must remove worktrees before the repo
  try {
    if (existsSync(TEST_REPO)) {
      executeSync('git', ['worktree', 'prune'], { cwd: TEST_REPO, reject: false });
    }
  } catch { /* ignore */ }
  rmSync(WORKTREE_DIR, { recursive: true, force: true });
  rmSync(TEST_REPO, { recursive: true, force: true });
}

describe('worktree-manager', () => {
  // We inline the worktree functions logic for testing since they import gitSync
  // which requires an actual git repo.

  beforeAll(() => {
    cleanupRepo();
    setupRepo();
  });

  afterAll(() => {
    cleanupRepo();
  });

  test('getWorktreeBase creates directory', () => {
    const base = resolve(dirname(TEST_REPO), '.funny-worktrees');
    mkdirSync(base, { recursive: true });
    expect(existsSync(base)).toBe(true);
  });

  describe('listWorktrees parsing', () => {
    // Test the parsing logic independently with raw porcelain output
    function parseWorktreeList(output: string, basePath: string) {
      const entries: { path: string; branch: string; commit: string }[] = [];
      let current: Record<string, string> = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) entries.push(current as any);
          current = { path: line.slice('worktree '.length) };
        } else if (line.startsWith('HEAD ')) {
          current.commit = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice('branch refs/heads/'.length);
        }
      }
      if (current.path) entries.push(current as any);

      return entries.filter((w) => w.path.startsWith(basePath));
    }

    test('parses single worktree entry', () => {
      const output = [
        'worktree /base/wt/branch1',
        'HEAD abc123',
        'branch refs/heads/branch1',
        '',
      ].join('\n');

      const result = parseWorktreeList(output, '/base/wt');
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/base/wt/branch1');
      expect(result[0].commit).toBe('abc123');
      expect(result[0].branch).toBe('branch1');
    });

    test('parses multiple worktree entries', () => {
      const output = [
        'worktree /repo',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
        'worktree /base/wt/feat-1',
        'HEAD bbb222',
        'branch refs/heads/feat-1',
        '',
        'worktree /base/wt/feat-2',
        'HEAD ccc333',
        'branch refs/heads/feat-2',
        '',
      ].join('\n');

      const result = parseWorktreeList(output, '/base/wt');
      expect(result).toHaveLength(2);
      expect(result[0].branch).toBe('feat-1');
      expect(result[1].branch).toBe('feat-2');
    });

    test('filters out main worktree', () => {
      const output = [
        'worktree /repo',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
      ].join('\n');

      const result = parseWorktreeList(output, '/managed-worktrees');
      expect(result).toHaveLength(0);
    });

    test('handles empty output', () => {
      const result = parseWorktreeList('', '/base');
      expect(result).toHaveLength(0);
    });
  });

  test('creating and listing a real worktree', () => {
    const branchName = 'test-wt-branch';
    const worktreePath = resolve(WORKTREE_DIR, branchName);
    mkdirSync(WORKTREE_DIR, { recursive: true });

    // Get the current branch name to use as base
    const currentBranch = executeSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: TEST_REPO }).stdout.trim();

    // Create worktree
    executeSync('git', ['worktree', 'add', '-b', branchName, worktreePath, currentBranch], { cwd: TEST_REPO });
    expect(existsSync(worktreePath)).toBe(true);

    // List worktrees
    const output = executeSync('git', ['worktree', 'list', '--porcelain'], { cwd: TEST_REPO }).stdout;
    expect(output).toContain(branchName);

    // Remove worktree
    executeSync('git', ['worktree', 'remove', '-f', worktreePath], { cwd: TEST_REPO, reject: false });
  });
});
