// Test the CLI fallback path — native module has known issues with status/diff counts
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

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
  revertFiles,
  commit,
  getDiff,
  getSingleFileDiff,
  getStatusSummary,
  deriveGitSyncState,
  initRepo,
  getLog,
  stash,
  stashPop,
  stashList,
  resetSoft,
  pull,
  push,
  mergeBranch,
  addToGitignore,
  getDiffSummary,
  invalidateStatusCache,
  getRemoteUrl,
} from '../git/index.js';
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
    invalidateStatusCache();
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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
        }),
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

    test('does not count untracked file lines as linesAdded', async () => {
      writeFileSync(resolve(repoPath, 'new-file.txt'), 'line1\nline2\nline3\n');
      writeFileSync(resolve(repoPath, 'another.txt'), 'single line\n');
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Untracked file content is not included in linesAdded — only actual
        // diff lines from git diff are counted, consistent with ReviewPane.
        expect(result.value.linesAdded).toBe(0);
        expect(result.value.linesDeleted).toBe(0);
      }
    });

    test('does not double-count staged new files', async () => {
      writeFileSync(resolve(repoPath, 'staged.txt'), 'a\nb\nc\n');
      executeSync('git', ['add', 'staged.txt'], { cwd: repoPath });
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.linesAdded).toBe(3);
      }
    });

    test('does not count untracked files even when mixed with binary', async () => {
      writeFileSync(
        resolve(repoPath, 'image.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      );
      writeFileSync(resolve(repoPath, 'text.txt'), 'hello\n');
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Untracked files don't contribute to linesAdded
        expect(result.value.linesAdded).toBe(0);
      }
    });
  });

  describe('getLog', () => {
    test('returns commit log entries', async () => {
      const result = await getLog(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        const entry = result.value[0];
        expect(entry.hash).toBeTruthy();
        expect(entry.shortHash).toBeTruthy();
        expect(entry.author).toBe('Test');
        expect(entry.message).toBe('initial commit');
        expect(entry.relativeDate).toBeTruthy();
      }
    });

    test('respects limit parameter', async () => {
      // Create additional commits
      writeFileSync(resolve(repoPath, 'log1.txt'), 'a');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'second commit'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'log2.txt'), 'b');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'third commit'], { cwd: repoPath });

      const result = await getLog(repoPath, 2);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(2);
        expect(result.value[0].message).toBe('third commit');
        expect(result.value[1].message).toBe('second commit');
      }
    });

    test('returns empty array for repo with no commits after filter', async () => {
      const emptyRepo = resolve(TMP, 'empty-log-repo');
      mkdirSync(emptyRepo, { recursive: true });
      executeSync('git', ['init'], { cwd: emptyRepo });
      // Repo with no commits — returns empty array
      const result = await getLog(emptyRepo);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('stash', () => {
    test('stashes current changes', async () => {
      writeFileSync(resolve(repoPath, 'stash-test.txt'), 'will be stashed');
      executeSync('git', ['add', '.'], { cwd: repoPath });

      const result = await stash(repoPath);
      expect(result.isOk()).toBe(true);

      // Verify working tree is clean after stash
      const status = executeSync('git', ['status', '--porcelain'], { cwd: repoPath });
      expect(status.stdout.trim()).toBe('');
    });

    test('returns ok even when nothing to stash (git stash push exits 0)', async () => {
      const result = await stash(repoPath);
      // git stash push -m exits 0 with "No local changes to save" message
      expect(result.isOk()).toBe(true);
    });
  });

  describe('stashPop', () => {
    test('pops most recent stash', async () => {
      writeFileSync(resolve(repoPath, 'pop-test.txt'), 'stash me');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['stash', 'push', '-m', 'test stash'], { cwd: repoPath });

      const result = await stashPop(repoPath);
      expect(result.isOk()).toBe(true);

      // File should be back
      const status = executeSync('git', ['status', '--porcelain'], { cwd: repoPath });
      expect(status.stdout).toContain('pop-test.txt');
    });

    test('returns error when no stash to pop', async () => {
      const result = await stashPop(repoPath);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('stashList', () => {
    test('returns empty array when no stashes', async () => {
      const result = await stashList(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    test('lists stash entries', async () => {
      writeFileSync(resolve(repoPath, 'list-test.txt'), 'data');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['stash', 'push', '-m', 'my stash message'], { cwd: repoPath });

      const result = await stashList(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(1);
        expect(result.value[0].index).toBe('stash@{0}');
        expect(result.value[0].message).toContain('my stash message');
      }
    });
  });

  describe('resetSoft', () => {
    test('undoes last commit keeping changes staged', async () => {
      writeFileSync(resolve(repoPath, 'reset-test.txt'), 'content');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'will be undone'], { cwd: repoPath });

      const logBefore = gitSync(['log', '--oneline'], repoPath);
      expect(logBefore).toContain('will be undone');

      const result = await resetSoft(repoPath);
      expect(result.isOk()).toBe(true);

      // Commit should be gone
      const logAfter = gitSync(['log', '--oneline'], repoPath);
      expect(logAfter).not.toContain('will be undone');

      // Changes should be staged
      const status = executeSync('git', ['status', '--porcelain'], { cwd: repoPath });
      expect(status.stdout).toContain('reset-test.txt');
    });

    test('fails when there is only one commit (no HEAD~1)', async () => {
      // The repo has only the initial commit — can't reset further
      const singleCommitRepo = resolve(TMP, 'single-commit');
      mkdirSync(singleCommitRepo, { recursive: true });
      executeSync('git', ['init'], { cwd: singleCommitRepo });
      executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: singleCommitRepo });
      executeSync('git', ['config', 'user.name', 'Test'], { cwd: singleCommitRepo });
      writeFileSync(resolve(singleCommitRepo, 'only.txt'), 'only');
      executeSync('git', ['add', '.'], { cwd: singleCommitRepo });
      executeSync('git', ['commit', '-m', 'only commit'], { cwd: singleCommitRepo });

      const result = await resetSoft(singleCommitRepo);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('commit with amend', () => {
    test('amends the last commit', async () => {
      writeFileSync(resolve(repoPath, 'amend-test.txt'), 'v1');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      await commit(repoPath, 'original message');

      writeFileSync(resolve(repoPath, 'amend-test2.txt'), 'v2');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      const result = await commit(repoPath, 'amended message', undefined, true);
      expect(result.isOk()).toBe(true);

      const log = gitSync(['log', '-1', '--format=%s'], repoPath);
      expect(log).toBe('amended message');
    });
  });

  describe('pull', () => {
    test('returns error when no remote configured', async () => {
      const result = await pull(repoPath);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('addToGitignore', () => {
    test('creates .gitignore if it does not exist', () => {
      const result = addToGitignore(repoPath, 'node_modules');
      expect(result.isOk()).toBe(true);

      const { readFileSync: readFs } = require('fs');
      const content = readFs(resolve(repoPath, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules');
    });

    test('appends pattern without duplicates', () => {
      writeFileSync(resolve(repoPath, '.gitignore'), 'dist\n');
      addToGitignore(repoPath, 'node_modules');
      addToGitignore(repoPath, 'node_modules'); // duplicate

      const { readFileSync: readFs } = require('fs');
      const content = readFs(resolve(repoPath, '.gitignore'), 'utf-8');
      const occurrences = content.split('node_modules').length - 1;
      expect(occurrences).toBe(1);
    });
  });

  describe('getDiffSummary', () => {
    test('returns empty for clean repo', async () => {
      const result = await getDiffSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.files).toEqual([]);
        expect(result.value.total).toBe(0);
        expect(result.value.truncated).toBe(false);
      }
    });

    test('detects changed files without diff content', async () => {
      writeFileSync(resolve(repoPath, 'summary1.txt'), 'a');
      writeFileSync(resolve(repoPath, 'summary2.txt'), 'b');

      const result = await getDiffSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.files.length).toBe(2);
        // No diff content in summary
        for (const f of result.value.files) {
          expect(f).not.toHaveProperty('diff');
        }
      }
    });

    test('excludes files matching exclude patterns', async () => {
      writeFileSync(resolve(repoPath, 'keep.txt'), 'keep');
      writeFileSync(resolve(repoPath, 'skip.log'), 'skip');

      const result = await getDiffSummary(repoPath, { excludePatterns: ['*.log'] });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const paths = result.value.files.map((f) => f.path);
        expect(paths).toContain('keep.txt');
        expect(paths).not.toContain('skip.log');
      }
    });

    test('truncates when maxFiles exceeded', async () => {
      writeFileSync(resolve(repoPath, 'trunc1.txt'), 'a');
      writeFileSync(resolve(repoPath, 'trunc2.txt'), 'b');
      writeFileSync(resolve(repoPath, 'trunc3.txt'), 'c');

      const result = await getDiffSummary(repoPath, { maxFiles: 1 });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.files.length).toBe(1);
        expect(result.value.total).toBe(3);
        expect(result.value.truncated).toBe(true);
      }
    });
  });

  describe('getRemoteUrl', () => {
    test('returns null when no remote configured', async () => {
      const result = await getRemoteUrl(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('revertFiles', () => {
    test('no-op with empty paths', async () => {
      const result = await revertFiles(repoPath, []);
      expect(result.isOk()).toBe(true);
    });

    test('reverts unstaged changes to tracked files', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Modified');
      const result = await revertFiles(repoPath, ['README.md']);
      expect(result.isOk()).toBe(true);

      const { readFileSync: readFs } = require('fs');
      const content = readFs(resolve(repoPath, 'README.md'), 'utf-8');
      expect(content).toBe('# Test');
    });
  });

  describe('getSingleFileDiff', () => {
    test('returns diff for unstaged tracked file', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Updated content');
      const result = await getSingleFileDiff(repoPath, 'README.md', false);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('Updated content');
      }
    });

    test('returns diff for staged file', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Staged change');
      executeSync('git', ['add', 'README.md'], { cwd: repoPath });
      const result = await getSingleFileDiff(repoPath, 'README.md', true);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('Staged change');
      }
    });

    test('returns diff for untracked file', async () => {
      writeFileSync(resolve(repoPath, 'brand-new.txt'), 'hello world');
      const result = await getSingleFileDiff(repoPath, 'brand-new.txt', false);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toContain('hello world');
      }
    });

    test('returns empty string for clean file', async () => {
      const result = await getSingleFileDiff(repoPath, 'README.md', false);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe('');
      }
    });
  });

  describe('invalidateStatusCache', () => {
    test('does not throw without arguments', () => {
      expect(() => invalidateStatusCache()).not.toThrow();
    });

    test('does not throw with a cwd argument', () => {
      expect(() => invalidateStatusCache(repoPath)).not.toThrow();
    });
  });

  describe('push', () => {
    test('returns error when no remote configured', async () => {
      const result = await push(repoPath);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('mergeBranch', () => {
    test('merges feature branch into target', async () => {
      // Get default branch name
      const branchResult = await getCurrentBranch(repoPath);
      expect(branchResult.isOk()).toBe(true);
      const defaultBranch = branchResult.isOk() ? branchResult.value : 'master';

      // Create feature branch and commit
      executeSync('git', ['checkout', '-b', 'feature-merge'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'feature.txt'), 'feature content');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'feature commit'], { cwd: repoPath });
      executeSync('git', ['checkout', defaultBranch], { cwd: repoPath });

      const result = await mergeBranch(repoPath, 'feature-merge', defaultBranch);
      expect(result.isOk()).toBe(true);

      // Verify file exists after merge
      const { existsSync } = require('fs');
      expect(existsSync(resolve(repoPath, 'feature.txt'))).toBe(true);
    });

    test('fails when working tree has uncommitted changes', async () => {
      const branchResult = await getCurrentBranch(repoPath);
      const defaultBranch = branchResult.isOk() ? branchResult.value : 'master';

      executeSync('git', ['checkout', '-b', 'feature-dirty'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'dirty-feature.txt'), 'content');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'dirty feature'], { cwd: repoPath });
      executeSync('git', ['checkout', defaultBranch], { cwd: repoPath });

      // Make uncommitted change
      writeFileSync(resolve(repoPath, 'uncommitted.txt'), 'dirty');

      const result = await mergeBranch(repoPath, 'feature-dirty', defaultBranch);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('getLog with baseBranch', () => {
    test('filters commits to only those after base branch divergence', async () => {
      const branchResult = await getCurrentBranch(repoPath);
      const defaultBranch = branchResult.isOk() ? branchResult.value : 'master';

      executeSync('git', ['checkout', '-b', 'feature-log'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'log-feature.txt'), 'a');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'feature log commit'], { cwd: repoPath });

      const result = await getLog(repoPath, 20, defaultBranch);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(1);
        expect(result.value[0].message).toBe('feature log commit');
      }
    });
  });

  describe('getDiff with deleted files', () => {
    test('detects deleted files', async () => {
      const { unlinkSync } = require('fs');
      unlinkSync(resolve(repoPath, 'README.md'));
      const result = await getDiff(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const deleted = result.value.find((d) => d.path === 'README.md');
        expect(deleted).toBeDefined();
        expect(deleted!.status).toBe('deleted');
      }
    });
  });

  describe('getStatusSummary with baseBranch', () => {
    test('counts unpushed commits relative to baseBranch', async () => {
      const branchResult = await getCurrentBranch(repoPath);
      const defaultBranch = branchResult.isOk() ? branchResult.value : 'master';

      executeSync('git', ['checkout', '-b', 'feature-status'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'status1.txt'), 'a');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'status commit 1'], { cwd: repoPath });
      writeFileSync(resolve(repoPath, 'status2.txt'), 'b');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['commit', '-m', 'status commit 2'], { cwd: repoPath });

      const result = await getStatusSummary(repoPath, defaultBranch);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.unpushedCommitCount).toBe(2);
      }
    });

    test('counts lines in tracked modifications', async () => {
      writeFileSync(resolve(repoPath, 'README.md'), '# Line 1\n# Line 2\n# Line 3\n');
      const result = await getStatusSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.linesAdded).toBeGreaterThan(0);
      }
    });
  });

  describe('getDiffSummary staged vs unstaged marking', () => {
    test('marks staged files as staged: true', async () => {
      writeFileSync(resolve(repoPath, 'staged-only.txt'), 'data');
      executeSync('git', ['add', 'staged-only.txt'], { cwd: repoPath });

      const result = await getDiffSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const staged = result.value.files.find((f) => f.path === 'staged-only.txt');
        expect(staged).toBeDefined();
        expect(staged!.staged).toBe(true);
      }
    });

    test('marks unstaged files as staged: false', async () => {
      writeFileSync(resolve(repoPath, 'unstaged-only.txt'), 'data');

      const result = await getDiffSummary(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const unstaged = result.value.files.find((f) => f.path === 'unstaged-only.txt');
        expect(unstaged).toBeDefined();
        expect(unstaged!.staged).toBe(false);
      }
    });
  });

  describe('stashList with multiple stashes', () => {
    test('lists multiple stash entries', async () => {
      writeFileSync(resolve(repoPath, 'stash1.txt'), 'a');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['stash', 'push', '-m', 'first stash'], { cwd: repoPath });

      writeFileSync(resolve(repoPath, 'stash2.txt'), 'b');
      executeSync('git', ['add', '.'], { cwd: repoPath });
      executeSync('git', ['stash', 'push', '-m', 'second stash'], { cwd: repoPath });

      const result = await stashList(repoPath);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(2);
        expect(result.value[0].message).toContain('second stash');
        expect(result.value[1].message).toContain('first stash');
      }
    });
  });

  describe('commit without staged changes', () => {
    test('returns error when nothing is staged', async () => {
      const result = await commit(repoPath, 'empty commit');
      expect(result.isErr()).toBe(true);
    });
  });
});
