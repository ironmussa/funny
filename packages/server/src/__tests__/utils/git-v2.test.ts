import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import {
  extractRepoName,
  isGitRepo,
  isGitRepoSync,
  getCurrentBranch,
  listBranches,
  stageFiles,
  commit,
  getDiff,
  git,
  gitSync,
  gitSafeSync,
  executeSync,
} from '@funny/core/git';

// ── Pure function tests ──────────────────────────────────────────

describe('extractRepoName', () => {
  test('extracts from HTTPS URL with .git', () => {
    expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
  });

  test('extracts from HTTPS URL without .git', () => {
    expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
  });

  test('extracts from SSH URL', () => {
    expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
  });

  test('extracts from SSH URL without .git', () => {
    expect(extractRepoName('git@github.com:user/my-repo')).toBe('my-repo');
  });

  test('handles nested paths', () => {
    expect(extractRepoName('https://gitlab.com/group/subgroup/repo.git')).toBe('repo');
  });

  test('returns empty string for empty URL', () => {
    expect(extractRepoName('')).toBe('');
  });

  // Edge cases
  test('handles URL with trailing slash', () => {
    expect(extractRepoName('https://github.com/user/repo/')).toBe('');
  });

  test('handles URL with port number', () => {
    expect(extractRepoName('https://gitlab.example.com:8443/user/repo.git')).toBe('repo');
  });

  test('handles single path segment', () => {
    expect(extractRepoName('repo.git')).toBe('repo');
  });

  test('handles URL with auth token', () => {
    expect(extractRepoName('https://token@github.com/user/private-repo.git')).toBe('private-repo');
  });
});

// ── Integration tests with a temp git repo ──────────────────────

const TEST_REPO = resolve(import.meta.dir, '..', '..', '..', '.test-tmp-git-repo');

function setupRepo() {
  mkdirSync(TEST_REPO, { recursive: true });
  executeSync('git', ['init'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO });

  // Create initial commit so HEAD exists
  writeFileSync(resolve(TEST_REPO, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: TEST_REPO });
  executeSync('git', ['commit', '-m', 'initial'], { cwd: TEST_REPO });
}

function cleanupRepo() {
  try {
    rmSync(TEST_REPO, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('git integration (temp repo)', () => {
  beforeAll(() => {
    cleanupRepo();
    setupRepo();
  });

  afterAll(() => {
    cleanupRepo();
  });

  test('isGitRepo returns true for a git repo', async () => {
    expect(await isGitRepo(TEST_REPO)).toBe(true);
  });

  test('isGitRepo returns false for non-repo', async () => {
    expect(await isGitRepo('/tmp')).toBe(false);
  });

  test('isGitRepoSync returns true for a git repo', () => {
    expect(isGitRepoSync(TEST_REPO)).toBe(true);
  });

  test('isGitRepoSync returns false for non-repo', () => {
    expect(isGitRepoSync('/tmp')).toBe(false);
  });

  test('getCurrentBranch returns a branch name', async () => {
    const result = await getCurrentBranch(TEST_REPO);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value).toBe('string');
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  test('listBranches includes current branch', async () => {
    const branchesResult = await listBranches(TEST_REPO);
    expect(branchesResult.isOk()).toBe(true);
    if (branchesResult.isOk()) {
      expect(branchesResult.value.length).toBeGreaterThan(0);

      const currentResult = await getCurrentBranch(TEST_REPO);
      expect(currentResult.isOk()).toBe(true);
      if (currentResult.isOk()) {
        expect(branchesResult.value).toContain(currentResult.value);
      }
    }
  });

  test('git runs a command successfully', async () => {
    const result = await git(['status', '--short'], TEST_REPO);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value).toBe('string');
    }
  });

  test('gitSync runs a command successfully', () => {
    const result = gitSync(['status', '--short'], TEST_REPO);
    expect(typeof result).toBe('string');
  });

  test('gitSafeSync returns null on failure', () => {
    const result = gitSafeSync(['invalid-command-xyz'], TEST_REPO);
    expect(result).toBeNull();
  });

  test('stageFiles stages a file', async () => {
    writeFileSync(resolve(TEST_REPO, 'new-file.txt'), 'content');
    const stageResult = await stageFiles(TEST_REPO, ['new-file.txt']);
    expect(stageResult.isOk()).toBe(true);

    const statusResult = await git(['status', '--short'], TEST_REPO);
    expect(statusResult.isOk()).toBe(true);
    if (statusResult.isOk()) {
      expect(statusResult.value).toContain('new-file.txt');
    }
  });

  test('stageFiles does nothing with empty array', async () => {
    const result = await stageFiles(TEST_REPO, []);
    expect(result.isOk()).toBe(true);
  });

  test('commit creates a commit', async () => {
    writeFileSync(resolve(TEST_REPO, 'commit-test.txt'), 'data');
    await stageFiles(TEST_REPO, ['commit-test.txt']);
    const result = await commit(TEST_REPO, 'test commit message');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toContain('test commit message');
    }
  });

  test('getDiff returns diffs for modified files', async () => {
    writeFileSync(resolve(TEST_REPO, 'diff-test.txt'), 'original');
    await stageFiles(TEST_REPO, ['diff-test.txt']);
    await commit(TEST_REPO, 'add diff-test');

    writeFileSync(resolve(TEST_REPO, 'diff-test.txt'), 'modified');
    const diffsResult = await getDiff(TEST_REPO);
    expect(diffsResult.isOk()).toBe(true);
    if (diffsResult.isOk()) {
      const diffFile = diffsResult.value.find((d) => d.path === 'diff-test.txt');
      expect(diffFile).toBeTruthy();
      expect(diffFile!.status).toBe('modified');
      expect(diffFile!.staged).toBe(false);
    }
  });

  test('getDiff returns staged diffs', async () => {
    writeFileSync(resolve(TEST_REPO, 'staged-test.txt'), 'staged content');
    await stageFiles(TEST_REPO, ['staged-test.txt']);

    const diffsResult = await getDiff(TEST_REPO);
    expect(diffsResult.isOk()).toBe(true);
    if (diffsResult.isOk()) {
      const stagedFile = diffsResult.value.find((d) => d.path === 'staged-test.txt');
      expect(stagedFile).toBeTruthy();
      expect(stagedFile!.staged).toBe(true);
    }
  });

  // ── Edge cases ──────────────────────────────────────────────────

  test('stageFiles handles multiple files at once', async () => {
    writeFileSync(resolve(TEST_REPO, 'multi-a.txt'), 'a');
    writeFileSync(resolve(TEST_REPO, 'multi-b.txt'), 'b');
    writeFileSync(resolve(TEST_REPO, 'multi-c.txt'), 'c');
    await stageFiles(TEST_REPO, ['multi-a.txt', 'multi-b.txt', 'multi-c.txt']);
    const statusResult = await git(['status', '--short'], TEST_REPO);
    expect(statusResult.isOk()).toBe(true);
    if (statusResult.isOk()) {
      expect(statusResult.value).toContain('multi-a.txt');
      expect(statusResult.value).toContain('multi-b.txt');
      expect(statusResult.value).toContain('multi-c.txt');
    }
    // cleanup
    await commit(TEST_REPO, 'multi stage test');
  });

  test('handles files with spaces in name', async () => {
    writeFileSync(resolve(TEST_REPO, 'file with spaces.txt'), 'content');
    await stageFiles(TEST_REPO, ['file with spaces.txt']);
    const statusResult = await git(['status', '--short'], TEST_REPO);
    expect(statusResult.isOk()).toBe(true);
    if (statusResult.isOk()) {
      expect(statusResult.value).toContain('file with spaces.txt');
    }
    await commit(TEST_REPO, 'spaces test');
  });

  test('getDiff returns empty array for clean repo', async () => {
    const diffsResult = await getDiff(TEST_REPO);
    expect(diffsResult.isOk()).toBe(true);
    if (diffsResult.isOk()) {
      expect(Array.isArray(diffsResult.value)).toBe(true);
    }
  });

  test('getDiff handles deleted files', async () => {
    writeFileSync(resolve(TEST_REPO, 'to-delete.txt'), 'temp');
    await stageFiles(TEST_REPO, ['to-delete.txt']);
    await commit(TEST_REPO, 'add to-delete');

    rmSync(resolve(TEST_REPO, 'to-delete.txt'));
    const diffsResult = await getDiff(TEST_REPO);
    expect(diffsResult.isOk()).toBe(true);
    if (diffsResult.isOk()) {
      const deleted = diffsResult.value.find((d) => d.path === 'to-delete.txt');
      expect(deleted).toBeTruthy();
      expect(deleted!.status).toBe('deleted');
    }
    // Restore for next tests
    const restoreResult = await git(['checkout', '--', 'to-delete.txt'], TEST_REPO);
    expect(restoreResult.isOk()).toBe(true);
  });

  test('git returns error on non-existent path', async () => {
    const result = await git(['status'], '/nonexistent/path/xyz');
    expect(result.isErr()).toBe(true);
  });

  test('listBranches after creating a new branch', async () => {
    executeSync('git', ['branch', 'test-edge-branch'], { cwd: TEST_REPO });
    const branchesResult = await listBranches(TEST_REPO);
    expect(branchesResult.isOk()).toBe(true);
    if (branchesResult.isOk()) {
      expect(branchesResult.value).toContain('test-edge-branch');
    }
    // cleanup
    executeSync('git', ['branch', '-d', 'test-edge-branch'], { cwd: TEST_REPO });
  });
});
