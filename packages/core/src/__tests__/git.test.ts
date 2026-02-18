import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  git,
  isGitRepo,
  isGitRepoSync,
  gitSync,
  gitSafeSync,
  getCurrentBranch,
  listBranches,
  getDefaultBranch,
  extractRepoName,
  stageFiles,
  unstageFiles,
  commit,
  getDiff,
  getStatusSummary,
  deriveGitSyncState,
  initRepo,
} from '../git/git.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-test-' + Date.now());

function initTestRepo(): string {
  const repoPath = resolve(TMP, 'repo');
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  writeFileSync(resolve(repoPath, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: repoPath });
  executeSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
}

describe('git operations', () => {
  let repoPath: string;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('git()', () => {
    test('executes git commands and returns trimmed stdout', async () => {
      const result = await git(['rev-parse', '--is-inside-work-tree'], repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe('true');
      }
    });

    test('returns Err for invalid git commands', async () => {
      const result = await git(['invalid-command'], repoPath);
      expect(result.isErr()).toBe(true);
    });

    test('returns Err for invalid cwd', async () => {
      const result = await git(['status'], '/nonexistent/path');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('isGitRepo', () => {
    test('returns true for git repositories', async () => {
      expect(await isGitRepo(repoPath)).toBe(true);
    });

    test('returns false for non-git directories', async () => {
      const nonRepo = resolve(TMP, 'non-repo');
      mkdirSync(nonRepo, { recursive: true });
      expect(await isGitRepo(nonRepo)).toBe(false);
    });
  });

  describe('isGitRepoSync', () => {
    test('returns true for git repositories', () => {
      expect(isGitRepoSync(repoPath)).toBe(true);
    });

    test('returns false for non-git directories', () => {
      const nonRepo = resolve(TMP, 'non-repo-sync');
      mkdirSync(nonRepo, { recursive: true });
      expect(isGitRepoSync(nonRepo)).toBe(false);
    });
  });

  describe('gitSync', () => {
    test('executes git command synchronously', () => {
      const result = gitSync(['rev-parse', '--is-inside-work-tree'], repoPath);
      expect(result).toBe('true');
    });
  });

  describe('gitSafeSync', () => {
    test('returns null on failure', () => {
      const result = gitSafeSync(['invalid-command'], repoPath);
      expect(result).toBeNull();
    });

    test('returns output on success', () => {
      const result = gitSafeSync(['rev-parse', '--is-inside-work-tree'], repoPath);
      expect(result).toBe('true');
    });
  });

  describe('getCurrentBranch', () => {
    test('returns current branch name', async () => {
      const result = await getCurrentBranch(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // After git init, branch is usually main or master
        expect(['main', 'master']).toContain(result.value);
      }
    });
  });

  describe('listBranches', () => {
    test('lists branches', async () => {
      const result = await listBranches(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
      }
    });

    test('includes newly created branch', async () => {
      executeSync('git', ['checkout', '-b', 'feature-test'], { cwd: repoPath });
      executeSync('git', ['checkout', '-'], { cwd: repoPath });

      const result = await listBranches(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('feature-test');
      }
    });
  });

  describe('getDefaultBranch', () => {
    test('returns a default branch', async () => {
      const result = await getDefaultBranch(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).not.toBeNull();
      }
    });
  });

  describe('extractRepoName', () => {
    test('extracts name from HTTPS URL', () => {
      expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
    });

    test('extracts name from SSH URL', () => {
      expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });

    test('handles URL without .git suffix', () => {
      expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
    });

    test('returns empty string for empty input', () => {
      expect(extractRepoName('')).toBe('');
    });
  });

  describe('initRepo', () => {
    test('initializes a new git repository', async () => {
      const newDir = resolve(TMP, 'new-repo');
      mkdirSync(newDir, { recursive: true });

      const result = await initRepo(newDir);
      expect(result.isOk()).toBe(true);
      expect(await isGitRepo(newDir)).toBe(true);
    });
  });

  describe('stageFiles', () => {
    test('stages files', async () => {
      writeFileSync(resolve(repoPath, 'new.txt'), 'content');
      const result = await stageFiles(repoPath, ['new.txt']);
      expect(result.isOk()).toBe(true);
    });

    test('no-op with empty paths', async () => {
      const result = await stageFiles(repoPath, []);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('unstageFiles', () => {
    test('no-op with empty paths', async () => {
      const result = await unstageFiles(repoPath, []);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('commit', () => {
    test('creates a commit', async () => {
      writeFileSync(resolve(repoPath, 'file.txt'), 'data');
      executeSync('git', ['add', '.'], { cwd: repoPath });

      const result = await commit(repoPath, 'test commit');
      expect(result.isOk()).toBe(true);
    });

    test('uses author identity when provided', async () => {
      writeFileSync(resolve(repoPath, 'authored.txt'), 'data');
      executeSync('git', ['add', '.'], { cwd: repoPath });

      const result = await commit(repoPath, 'authored commit', {
        author: { name: 'Custom Author', email: 'custom@test.com' },
      });
      expect(result.isOk()).toBe(true);

      // Verify author
      const log = gitSync(['log', '-1', '--format=%an <%ae>'], repoPath);
      expect(log).toContain('Custom Author');
    });
  });

  describe('getDiff', () => {
    test('returns empty array for clean repo', async () => {
      const result = await getDiff(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    test('detects unstaged changes', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Updated');
      const result = await getDiff(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.value[0].staged).toBe(false);
      }
    });

    test('detects staged changes', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Staged');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      const result = await getDiff(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const staged = result.value.filter((d) => d.staged);
        expect(staged.length).toBeGreaterThan(0);
      }
    });

    test('detects untracked files as added', async () => {
      writeFileSync(resolve(repoPath, 'untracked.txt'), 'new file');
      const result = await getDiff(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const untracked = result.value.find((d) => d.path === 'untracked.txt');
        expect(untracked).toBeDefined();
        expect(untracked!.status).toBe('added');
        expect(untracked!.staged).toBe(false);
      }
    });
  });

  describe('deriveGitSyncState', () => {
    test('returns merged when isMergedIntoBase', () => {
      expect(
        deriveGitSyncState({
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: true,
          linesAdded: 0,
          linesDeleted: 0,
        })
      ).toBe('merged');
    });

    test('returns dirty when files are dirty', () => {
      expect(
        deriveGitSyncState({
          dirtyFileCount: 3,
          unpushedCommitCount: 0,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded: 10,
          linesDeleted: 5,
        })
      ).toBe('dirty');
    });

    test('returns unpushed when commits exist', () => {
      expect(
        deriveGitSyncState({
          dirtyFileCount: 0,
          unpushedCommitCount: 2,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded: 0,
          linesDeleted: 0,
        })
      ).toBe('unpushed');
    });

    test('returns pushed when remote branch exists', () => {
      expect(
        deriveGitSyncState({
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 0,
          linesDeleted: 0,
        })
      ).toBe('pushed');
    });

    test('returns clean when nothing to report', () => {
      expect(
        deriveGitSyncState({
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded: 0,
          linesDeleted: 0,
        })
      ).toBe('clean');
    });

    test('priority: dirty > unpushed > merged > pushed > clean', () => {
      // dirty takes priority over merged
      expect(
        deriveGitSyncState({
          dirtyFileCount: 5,
          unpushedCommitCount: 3,
          hasRemoteBranch: true,
          isMergedIntoBase: true,
          linesAdded: 10,
          linesDeleted: 5,
        })
      ).toBe('dirty');

      // unpushed takes priority over merged
      expect(
        deriveGitSyncState({
          dirtyFileCount: 0,
          unpushedCommitCount: 2,
          hasRemoteBranch: true,
          isMergedIntoBase: true,
          linesAdded: 0,
          linesDeleted: 0,
        })
      ).toBe('unpushed');

      // dirty takes priority over unpushed
      expect(
        deriveGitSyncState({
          dirtyFileCount: 1,
          unpushedCommitCount: 2,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 5,
          linesDeleted: 0,
        })
      ).toBe('dirty');
    });
  });

  describe('getStatusSummary', () => {
    test('returns clean summary for clean repo', async () => {
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.dirtyFileCount).toBe(0);
      }
    });

    test('counts dirty files', async () => {
      writeFileSync(resolve(repoPath, 'dirty1.txt'), 'a');
      writeFileSync(resolve(repoPath, 'dirty2.txt'), 'b');
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.dirtyFileCount).toBe(2);
      }
    });
  });
});
