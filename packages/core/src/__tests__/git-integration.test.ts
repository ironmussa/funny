// Test the CLI fallback path — native module has known issues with status/diff counts
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import {
  commit,
  deriveGitSyncState,
  getCommitBody,
  getCommitFileDiff,
  getCommitFiles,
  getCurrentBranch,
  getDiff,
  getDiffSummary,
  getLog,
  getSingleFileDiff,
  getStatusSummary,
  getUnpushedHashes,
  gitSync,
  invalidateStatusCache,
  mergeBranch,
  revertFiles,
  resetSoft,
  stageFiles,
  stash,
  stashList,
  stashPop,
  unstageFiles,
} from '../git/git.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-integration-' + Date.now());

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

// ═══════════════════════════════════════════════════════════════════════════
// Group 1: Full Commit Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: full commit lifecycle', () => {
  let repoPath: string;

  beforeEach(() => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('create files, stage subset, commit, inspect commit details', async () => {
    // 1. Create 3 new files
    writeFileSync(resolve(repoPath, 'alpha.ts'), 'export const a = 1;\n');
    writeFileSync(resolve(repoPath, 'beta.ts'), 'export const b = 2;\nexport const b2 = 3;\n');
    writeFileSync(resolve(repoPath, 'gamma.txt'), 'line1\nline2\nline3\n');

    // 2. getDiffSummary shows all 3 as unstaged/added
    const summaryBefore = await getDiffSummary(repoPath);
    expect(summaryBefore.isOk()).toBe(true);
    if (summaryBefore.isOk()) {
      expect(summaryBefore.value.total).toBe(3);
      expect(summaryBefore.value.truncated).toBe(false);
      const paths = summaryBefore.value.files.map((f) => f.path).sort();
      expect(paths).toEqual(['alpha.ts', 'beta.ts', 'gamma.txt']);
      for (const f of summaryBefore.value.files) {
        expect(f.staged).toBe(false);
        expect(f.status).toBe('added');
      }
    }

    // 3. Stage only alpha.ts and beta.ts
    const stageResult = await stageFiles(repoPath, ['alpha.ts', 'beta.ts']);
    expect(stageResult.isOk()).toBe(true);

    // 4. getDiffSummary reflects mixed staged state
    const summaryAfterStage = await getDiffSummary(repoPath);
    expect(summaryAfterStage.isOk()).toBe(true);
    if (summaryAfterStage.isOk()) {
      const alpha = summaryAfterStage.value.files.find((f) => f.path === 'alpha.ts');
      const beta = summaryAfterStage.value.files.find((f) => f.path === 'beta.ts');
      const gamma = summaryAfterStage.value.files.find((f) => f.path === 'gamma.txt');
      expect(alpha?.staged).toBe(true);
      expect(beta?.staged).toBe(true);
      expect(gamma?.staged).toBe(false);
    }

    // 5. getSingleFileDiff for staged and untracked
    const alphaDiff = await getSingleFileDiff(repoPath, 'alpha.ts', true);
    expect(alphaDiff.isOk()).toBe(true);
    if (alphaDiff.isOk()) {
      expect(alphaDiff.value).toContain('export const a = 1;');
    }

    const gammaDiff = await getSingleFileDiff(repoPath, 'gamma.txt', false);
    expect(gammaDiff.isOk()).toBe(true);
    if (gammaDiff.isOk()) {
      expect(gammaDiff.value).toContain('line1');
      expect(gammaDiff.value).toContain('line2');
      expect(gammaDiff.value).toContain('line3');
    }

    // 6. Commit staged files
    const commitResult = await commit(repoPath, 'add alpha and beta');
    expect(commitResult.isOk()).toBe(true);

    // 7. getLog shows the new commit
    const logResult = await getLog(repoPath);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      expect(logResult.value[0].message).toBe('add alpha and beta');
      expect(logResult.value[0].author).toBe('Test');
      expect(logResult.value[0].hash).toBeTruthy();
      expect(logResult.value.length).toBeGreaterThanOrEqual(2);

      const hash = logResult.value[0].hash;

      // 8. getStatusSummary: gamma.txt still dirty
      const statusAfterCommit = await getStatusSummary(repoPath);
      expect(statusAfterCommit.isOk()).toBe(true);
      if (statusAfterCommit.isOk()) {
        expect(statusAfterCommit.value.dirtyFileCount).toBe(1);
      }

      // 9. getCommitFiles: 2 files added
      const filesResult = await getCommitFiles(repoPath, hash);
      expect(filesResult.isOk()).toBe(true);
      if (filesResult.isOk()) {
        expect(filesResult.value.length).toBe(2);
        const commitPaths = filesResult.value.map((f) => f.path).sort();
        expect(commitPaths).toEqual(['alpha.ts', 'beta.ts']);
        const alphaEntry = filesResult.value.find((f) => f.path === 'alpha.ts')!;
        expect(alphaEntry.status).toBe('added');
        expect(alphaEntry.additions).toBe(1);
        expect(alphaEntry.deletions).toBe(0);
        const betaEntry = filesResult.value.find((f) => f.path === 'beta.ts')!;
        expect(betaEntry.additions).toBe(2);
      }

      // 10. getCommitFileDiff: verify exact diff content
      const alphaCommitDiff = await getCommitFileDiff(repoPath, hash, 'alpha.ts');
      expect(alphaCommitDiff.isOk()).toBe(true);
      if (alphaCommitDiff.isOk()) {
        expect(alphaCommitDiff.value).toContain('+export const a = 1;');
      }

      const betaCommitDiff = await getCommitFileDiff(repoPath, hash, 'beta.ts');
      expect(betaCommitDiff.isOk()).toBe(true);
      if (betaCommitDiff.isOk()) {
        expect(betaCommitDiff.value).toContain('+export const b = 2;');
        expect(betaCommitDiff.value).toContain('+export const b2 = 3;');
      }
    }
  });

  test('commit with body text, verify getCommitBody', async () => {
    writeFileSync(resolve(repoPath, 'body-test.txt'), 'content');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync(
      'git',
      ['commit', '-m', 'subject line\n\nThis is the body.\nWith multiple lines.'],
      {
        cwd: repoPath,
      },
    );

    const logResult = await getLog(repoPath, 1);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      const hash = logResult.value[0].hash;
      expect(logResult.value[0].message).toBe('subject line');

      const bodyResult = await getCommitBody(repoPath, hash);
      expect(bodyResult.isOk()).toBe(true);
      if (bodyResult.isOk()) {
        expect(bodyResult.value).toContain('This is the body.');
        expect(bodyResult.value).toContain('With multiple lines.');
      }
    }
  });

  test('modify tracked file, commit, inspect diff shows exact changes', async () => {
    // Modify README.md
    writeFileSync(resolve(repoPath, 'README.md'), '# Updated\n\nNew content\n');

    // Verify unstaged diff
    const unstaged = await getSingleFileDiff(repoPath, 'README.md', false);
    expect(unstaged.isOk()).toBe(true);
    if (unstaged.isOk()) {
      expect(unstaged.value).toContain('-# Test');
      expect(unstaged.value).toContain('+# Updated');
    }

    // Stage and commit
    await stageFiles(repoPath, ['README.md']);
    const commitResult = await commit(repoPath, 'update readme');
    expect(commitResult.isOk()).toBe(true);

    // Inspect commit
    const logResult = await getLog(repoPath, 1);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      const hash = logResult.value[0].hash;

      const filesResult = await getCommitFiles(repoPath, hash);
      expect(filesResult.isOk()).toBe(true);
      if (filesResult.isOk()) {
        expect(filesResult.value.length).toBe(1);
        expect(filesResult.value[0].status).toBe('modified');
        expect(filesResult.value[0].additions).toBeGreaterThanOrEqual(2);
        expect(filesResult.value[0].deletions).toBeGreaterThanOrEqual(1);
      }

      const diffResult = await getCommitFileDiff(repoPath, hash, 'README.md');
      expect(diffResult.isOk()).toBe(true);
      if (diffResult.isOk()) {
        expect(diffResult.value).toContain('+# Updated');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 2: Stage/Unstage/Revert Combinations
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: stage/unstage/revert combinations', () => {
  let repoPath: string;

  beforeEach(() => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('stage all, unstage some, getDiff reflects mixed state', async () => {
    writeFileSync(resolve(repoPath, 'a.txt'), 'aaa');
    writeFileSync(resolve(repoPath, 'b.txt'), 'bbb');
    writeFileSync(resolve(repoPath, 'c.txt'), 'ccc');

    await stageFiles(repoPath, ['a.txt', 'b.txt', 'c.txt']);
    await unstageFiles(repoPath, ['b.txt']);

    const diffResult = await getDiff(repoPath);
    expect(diffResult.isOk()).toBe(true);
    if (diffResult.isOk()) {
      const a = diffResult.value.find((d) => d.path === 'a.txt');
      const b = diffResult.value.find((d) => d.path === 'b.txt');
      const c = diffResult.value.find((d) => d.path === 'c.txt');

      expect(a?.staged).toBe(true);
      expect(b?.staged).toBe(false);
      expect(c?.staged).toBe(true);
    }
  });

  test('modify tracked file, stage, modify again — staged and unstaged diffs differ', async () => {
    // Stage first modification
    writeFileSync(resolve(repoPath, 'README.md'), '# Version 2\n');
    await stageFiles(repoPath, ['README.md']);

    // Make a second modification without staging
    writeFileSync(resolve(repoPath, 'README.md'), '# Version 3\n');

    // Staged diff: Test -> Version 2
    const stagedDiff = await getSingleFileDiff(repoPath, 'README.md', true);
    expect(stagedDiff.isOk()).toBe(true);
    if (stagedDiff.isOk()) {
      expect(stagedDiff.value).toContain('+# Version 2');
      expect(stagedDiff.value).toContain('-# Test');
    }

    // Unstaged diff: Version 2 -> Version 3
    const unstagedDiff = await getSingleFileDiff(repoPath, 'README.md', false);
    expect(unstagedDiff.isOk()).toBe(true);
    if (unstagedDiff.isOk()) {
      expect(unstagedDiff.value).toContain('+# Version 3');
      expect(unstagedDiff.value).toContain('-# Version 2');
    }
  });

  test('revert untracked file deletes it from disk', async () => {
    writeFileSync(resolve(repoPath, 'temp-untracked.txt'), 'will be deleted');
    expect(existsSync(resolve(repoPath, 'temp-untracked.txt'))).toBe(true);

    const result = await revertFiles(repoPath, ['temp-untracked.txt']);
    expect(result.isOk()).toBe(true);

    expect(existsSync(resolve(repoPath, 'temp-untracked.txt'))).toBe(false);

    const diffResult = await getDiff(repoPath);
    expect(diffResult.isOk()).toBe(true);
    if (diffResult.isOk()) {
      expect(diffResult.value).toEqual([]);
    }
  });

  test('revert modified tracked file restores original content', async () => {
    writeFileSync(resolve(repoPath, 'README.md'), '# Changed');
    const result = await revertFiles(repoPath, ['README.md']);
    expect(result.isOk()).toBe(true);

    const content = readFileSync(resolve(repoPath, 'README.md'), 'utf-8');
    expect(content).toBe('# Test');

    const diffResult = await getDiff(repoPath);
    expect(diffResult.isOk()).toBe(true);
    if (diffResult.isOk()) {
      expect(diffResult.value).toEqual([]);
    }
  });

  test('stage a deleted file shows status deleted and staged', async () => {
    unlinkSync(resolve(repoPath, 'README.md'));

    // Before staging: deleted, unstaged
    const diffBefore = await getDiff(repoPath);
    expect(diffBefore.isOk()).toBe(true);
    if (diffBefore.isOk()) {
      const deleted = diffBefore.value.find((d) => d.path === 'README.md');
      expect(deleted).toBeDefined();
      expect(deleted!.status).toBe('deleted');
      expect(deleted!.staged).toBe(false);
    }

    // Stage the deletion
    await stageFiles(repoPath, ['README.md']);

    // After staging: deleted, staged
    const diffAfter = await getDiff(repoPath);
    expect(diffAfter.isOk()).toBe(true);
    if (diffAfter.isOk()) {
      const deleted = diffAfter.value.find((d) => d.path === 'README.md');
      expect(deleted).toBeDefined();
      expect(deleted!.status).toBe('deleted');
      expect(deleted!.staged).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 3: Branch & Merge Workflows
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: branch & merge workflows', () => {
  let repoPath: string;
  let defaultBranch: string;

  beforeEach(async () => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();

    const branchResult = await getCurrentBranch(repoPath);
    defaultBranch = branchResult.isOk() ? branchResult.value : 'master';
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('getLog with baseBranch shows only feature branch commits', async () => {
    executeSync('git', ['checkout', '-b', 'feature-branch'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'feature1.txt'), 'a');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'feature commit 1'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'feature2.txt'), 'b');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'feature commit 2'], { cwd: repoPath });

    // With baseBranch filter: only 2 feature commits
    const filtered = await getLog(repoPath, 20, defaultBranch);
    expect(filtered.isOk()).toBe(true);
    if (filtered.isOk()) {
      expect(filtered.value.length).toBe(2);
      expect(filtered.value[0].message).toBe('feature commit 2');
      expect(filtered.value[1].message).toBe('feature commit 1');
    }

    // Without filter: all 3 commits
    const all = await getLog(repoPath);
    expect(all.isOk()).toBe(true);
    if (all.isOk()) {
      expect(all.value.length).toBe(3);
    }
  });

  test('getStatusSummary shows unpushedCommitCount and deriveGitSyncState returns unpushed', async () => {
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
      expect(result.value.dirtyFileCount).toBe(0);
      expect(deriveGitSyncState(result.value)).toBe('unpushed');
    }
  });

  test('mergeBranch merges feature into target and shows merge commit', async () => {
    // Create feature branch with a file
    executeSync('git', ['checkout', '-b', 'feature-merge-int'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'merge-file.txt'), 'merged content');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'feature for merge'], { cwd: repoPath });

    // Switch back and merge
    executeSync('git', ['checkout', defaultBranch], { cwd: repoPath });
    const mergeResult = await mergeBranch(repoPath, 'feature-merge-int', defaultBranch);
    expect(mergeResult.isOk()).toBe(true);

    // Verify file exists after merge
    expect(existsSync(resolve(repoPath, 'merge-file.txt'))).toBe(true);
    expect(readFileSync(resolve(repoPath, 'merge-file.txt'), 'utf-8')).toBe('merged content');

    // Verify merge commit in log
    const logResult = await getLog(repoPath);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      expect(logResult.value[0].message).toContain('Merge');
    }
  });

  test('deriveGitSyncState transitions: clean → dirty → unpushed → clean', async () => {
    // Clean state
    const clean = await getStatusSummary(repoPath);
    expect(clean.isOk()).toBe(true);
    if (clean.isOk()) expect(deriveGitSyncState(clean.value)).toBe('clean');

    // Dirty state
    writeFileSync(resolve(repoPath, 'dirty.txt'), 'dirty');
    invalidateStatusCache();
    const dirty = await getStatusSummary(repoPath);
    expect(dirty.isOk()).toBe(true);
    if (dirty.isOk()) expect(deriveGitSyncState(dirty.value)).toBe('dirty');

    // Create feature branch with commit → unpushed relative to default
    executeSync('git', ['checkout', '-b', 'feature-transition'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'dirty.txt'), 'committed');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'feature commit'], { cwd: repoPath });
    invalidateStatusCache();
    const unpushed = await getStatusSummary(repoPath, defaultBranch);
    expect(unpushed.isOk()).toBe(true);
    if (unpushed.isOk()) expect(deriveGitSyncState(unpushed.value)).toBe('unpushed');

    // Merge back → clean on default branch
    executeSync('git', ['checkout', defaultBranch], { cwd: repoPath });
    await mergeBranch(repoPath, 'feature-transition', defaultBranch);
    invalidateStatusCache();
    const cleanAgain = await getStatusSummary(repoPath);
    expect(cleanAgain.isOk()).toBe(true);
    if (cleanAgain.isOk()) expect(deriveGitSyncState(cleanAgain.value)).toBe('clean');
  });

  test('getUnpushedHashes returns all commits when no remote exists', async () => {
    // Create feature branch with 2 commits
    executeSync('git', ['checkout', '-b', 'feature-unpushed'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'unpush1.txt'), 'a');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'unpush commit 1'], { cwd: repoPath });
    writeFileSync(resolve(repoPath, 'unpush2.txt'), 'b');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'unpush commit 2'], { cwd: repoPath });

    // Get all commit hashes from log
    const logResult = await getLog(repoPath);
    expect(logResult.isOk()).toBe(true);

    const unpushedResult = await getUnpushedHashes(repoPath);
    expect(unpushedResult.isOk()).toBe(true);

    if (logResult.isOk() && unpushedResult.isOk()) {
      const unpushedSet = unpushedResult.value;
      // Without remotes, all commits are "unpushed"
      for (const entry of logResult.value) {
        expect(unpushedSet.has(entry.hash)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 4: Stash Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: stash lifecycle', () => {
  let repoPath: string;

  beforeEach(() => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('full stash/pop cycle: dirty → stash → clean → pop → dirty', async () => {
    writeFileSync(resolve(repoPath, 'stash-target.txt'), 'original content\nline 2\n');
    executeSync('git', ['add', '.'], { cwd: repoPath });

    // Stash
    const stashResult = await stash(repoPath);
    expect(stashResult.isOk()).toBe(true);

    // Verify clean
    expect(existsSync(resolve(repoPath, 'stash-target.txt'))).toBe(false);
    invalidateStatusCache();
    const statusClean = await getStatusSummary(repoPath);
    expect(statusClean.isOk()).toBe(true);
    if (statusClean.isOk()) expect(statusClean.value.dirtyFileCount).toBe(0);

    const diffClean = await getDiff(repoPath);
    expect(diffClean.isOk()).toBe(true);
    if (diffClean.isOk()) expect(diffClean.value).toEqual([]);

    // Verify stash list
    const listResult = await stashList(repoPath);
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value.length).toBe(1);
      expect(listResult.value[0].message).toContain('funny: stashed changes');
    }

    // Pop stash
    const popResult = await stashPop(repoPath);
    expect(popResult.isOk()).toBe(true);

    // Verify restored
    expect(existsSync(resolve(repoPath, 'stash-target.txt'))).toBe(true);
    invalidateStatusCache();
    const statusDirty = await getStatusSummary(repoPath);
    expect(statusDirty.isOk()).toBe(true);
    if (statusDirty.isOk()) expect(statusDirty.value.dirtyFileCount).toBe(1);

    // Stash list is empty
    const listAfterPop = await stashList(repoPath);
    expect(listAfterPop.isOk()).toBe(true);
    if (listAfterPop.isOk()) expect(listAfterPop.value).toEqual([]);
  });

  test('multiple stashes pop in LIFO order', async () => {
    // First stash
    writeFileSync(resolve(repoPath, 'first.txt'), 'first');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    await stash(repoPath);

    // Second stash
    writeFileSync(resolve(repoPath, 'second.txt'), 'second');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    await stash(repoPath);

    // Stash list: 2 entries, most recent first
    const listResult = await stashList(repoPath);
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value.length).toBe(2);
      expect(listResult.value[0].index).toBe('stash@{0}');
      expect(listResult.value[1].index).toBe('stash@{1}');
    }

    // Pop most recent — second.txt
    await stashPop(repoPath);
    expect(existsSync(resolve(repoPath, 'second.txt'))).toBe(true);
    expect(existsSync(resolve(repoPath, 'first.txt'))).toBe(false);

    // Pop remaining — first.txt
    // Clean up second.txt first so stash pop doesn't conflict
    executeSync('git', ['checkout', '--', '.'], { cwd: repoPath, reject: false });
    rmSync(resolve(repoPath, 'second.txt'), { force: true });
    await stashPop(repoPath);
    expect(existsSync(resolve(repoPath, 'first.txt'))).toBe(true);

    // No more stashes
    const listEmpty = await stashList(repoPath);
    expect(listEmpty.isOk()).toBe(true);
    if (listEmpty.isOk()) expect(listEmpty.value).toEqual([]);
  });

  test('stash tracked modification restores original, pop restores modification', async () => {
    // Modify tracked file without staging
    writeFileSync(resolve(repoPath, 'README.md'), '# Modified for stash');

    const stashResult = await stash(repoPath);
    expect(stashResult.isOk()).toBe(true);

    // Original content restored
    expect(readFileSync(resolve(repoPath, 'README.md'), 'utf-8')).toBe('# Test');

    // Pop restores modification
    const popResult = await stashPop(repoPath);
    expect(popResult.isOk()).toBe(true);
    expect(readFileSync(resolve(repoPath, 'README.md'), 'utf-8')).toBe('# Modified for stash');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 5: Reset & Amend Workflows
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: reset & amend workflows', () => {
  let repoPath: string;

  beforeEach(() => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('commit, resetSoft, verify staged, recommit with different message', async () => {
    writeFileSync(resolve(repoPath, 'reset-file.txt'), 'content');
    await stageFiles(repoPath, ['reset-file.txt']);
    await commit(repoPath, 'original msg');

    // Verify commit exists
    const logBefore = await getLog(repoPath, 1);
    expect(logBefore.isOk()).toBe(true);
    if (logBefore.isOk()) expect(logBefore.value[0].message).toBe('original msg');

    // Reset soft
    const resetResult = await resetSoft(repoPath);
    expect(resetResult.isOk()).toBe(true);

    // Commit is gone, changes are staged
    const logAfter = await getLog(repoPath, 1);
    expect(logAfter.isOk()).toBe(true);
    if (logAfter.isOk()) expect(logAfter.value[0].message).toBe('initial commit');

    const diffAfterReset = await getDiff(repoPath);
    expect(diffAfterReset.isOk()).toBe(true);
    if (diffAfterReset.isOk()) {
      const file = diffAfterReset.value.find((d) => d.path === 'reset-file.txt');
      expect(file).toBeDefined();
      expect(file!.staged).toBe(true);
      expect(file!.status).toBe('added');
    }

    // Recommit with different message
    const recommit = await commit(repoPath, 'better message');
    expect(recommit.isOk()).toBe(true);

    const logFinal = await getLog(repoPath, 1);
    expect(logFinal.isOk()).toBe(true);
    if (logFinal.isOk()) expect(logFinal.value[0].message).toBe('better message');
  });

  test('amend commit adds files, changes hash, single commit', async () => {
    // First commit
    writeFileSync(resolve(repoPath, 'first.txt'), 'first');
    await stageFiles(repoPath, ['first.txt']);
    await commit(repoPath, 'first file');

    const logBefore = await getLog(repoPath);
    expect(logBefore.isOk()).toBe(true);
    const hash1 = logBefore.isOk() ? logBefore.value[0].hash : '';
    const commitCountBefore = logBefore.isOk() ? logBefore.value.length : 0;

    // Verify first commit has 1 file
    const filesBefore = await getCommitFiles(repoPath, hash1);
    expect(filesBefore.isOk()).toBe(true);
    if (filesBefore.isOk()) expect(filesBefore.value.length).toBe(1);

    // Amend with additional file
    writeFileSync(resolve(repoPath, 'second.txt'), 'second');
    await stageFiles(repoPath, ['second.txt']);
    const amendResult = await commit(repoPath, 'first and second files', undefined, true);
    expect(amendResult.isOk()).toBe(true);

    const logAfter = await getLog(repoPath);
    expect(logAfter.isOk()).toBe(true);
    if (logAfter.isOk()) {
      const hash2 = logAfter.value[0].hash;
      expect(logAfter.value[0].message).toBe('first and second files');
      expect(hash2).not.toBe(hash1); // Amend creates new hash
      expect(logAfter.value.length).toBe(commitCountBefore); // Same count (amend, not new)

      // Amended commit has both files
      const filesAfter = await getCommitFiles(repoPath, hash2);
      expect(filesAfter.isOk()).toBe(true);
      if (filesAfter.isOk()) {
        expect(filesAfter.value.length).toBe(2);
        const paths = filesAfter.value.map((f) => f.path).sort();
        expect(paths).toEqual(['first.txt', 'second.txt']);
      }
    }
  });

  test('getCommitBody updates after amend', async () => {
    writeFileSync(resolve(repoPath, 'amend-body.txt'), 'data');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '-m', 'subject\n\noriginal body'], { cwd: repoPath });

    const logBefore = await getLog(repoPath, 1);
    expect(logBefore.isOk()).toBe(true);
    const hash1 = logBefore.isOk() ? logBefore.value[0].hash : '';

    const bodyBefore = await getCommitBody(repoPath, hash1);
    expect(bodyBefore.isOk()).toBe(true);
    if (bodyBefore.isOk()) expect(bodyBefore.value).toContain('original body');

    // Amend with new body
    writeFileSync(resolve(repoPath, 'amend-body2.txt'), 'more');
    executeSync('git', ['add', '.'], { cwd: repoPath });
    executeSync('git', ['commit', '--amend', '-m', 'subject\n\namended body'], { cwd: repoPath });

    const logAfter = await getLog(repoPath, 1);
    expect(logAfter.isOk()).toBe(true);
    const hash2 = logAfter.isOk() ? logAfter.value[0].hash : '';
    expect(hash2).not.toBe(hash1);

    const bodyAfter = await getCommitBody(repoPath, hash2);
    expect(bodyAfter.isOk()).toBe(true);
    if (bodyAfter.isOk()) expect(bodyAfter.value).toContain('amended body');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 6: Diff Accuracy
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: diff accuracy', () => {
  let repoPath: string;

  beforeEach(() => {
    invalidateStatusCache();
    mkdirSync(TMP, { recursive: true });
    repoPath = initTestRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('new file diff contains exact added lines', async () => {
    writeFileSync(resolve(repoPath, 'precise.txt'), 'line A\nline B\nline C\n');

    const diff = await getSingleFileDiff(repoPath, 'precise.txt', false);
    expect(diff.isOk()).toBe(true);
    if (diff.isOk()) {
      expect(diff.value).toContain('+line A');
      expect(diff.value).toContain('+line B');
      expect(diff.value).toContain('+line C');
    }

    // Stage, commit, verify via getCommitFileDiff
    await stageFiles(repoPath, ['precise.txt']);
    await commit(repoPath, 'add precise');
    const logResult = await getLog(repoPath, 1);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      const commitDiff = await getCommitFileDiff(repoPath, logResult.value[0].hash, 'precise.txt');
      expect(commitDiff.isOk()).toBe(true);
      if (commitDiff.isOk()) {
        expect(commitDiff.value).toContain('+line A');
        expect(commitDiff.value).toContain('+line B');
        expect(commitDiff.value).toContain('+line C');
      }
    }
  });

  test('modified file diff shows old and new lines', async () => {
    writeFileSync(resolve(repoPath, 'README.md'), '# New Title\n\nParagraph\n');

    const diff = await getSingleFileDiff(repoPath, 'README.md', false);
    expect(diff.isOk()).toBe(true);
    if (diff.isOk()) {
      expect(diff.value).toContain('-# Test');
      expect(diff.value).toContain('+# New Title');
      expect(diff.value).toContain('+Paragraph');
    }
  });

  test('deleted file shows deletion in diff and commit', async () => {
    unlinkSync(resolve(repoPath, 'README.md'));

    // getDiff reports deletion
    const diffResult = await getDiff(repoPath);
    expect(diffResult.isOk()).toBe(true);
    if (diffResult.isOk()) {
      const deleted = diffResult.value.find((d) => d.path === 'README.md');
      expect(deleted).toBeDefined();
      expect(deleted!.status).toBe('deleted');
    }

    // getSingleFileDiff shows removed line
    const fileDiff = await getSingleFileDiff(repoPath, 'README.md', false);
    expect(fileDiff.isOk()).toBe(true);
    if (fileDiff.isOk()) {
      expect(fileDiff.value).toContain('-# Test');
    }

    // Stage, commit, inspect via getCommitFileDiff
    await stageFiles(repoPath, ['README.md']);
    await commit(repoPath, 'delete readme');
    const logResult = await getLog(repoPath, 1);
    expect(logResult.isOk()).toBe(true);
    if (logResult.isOk()) {
      const hash = logResult.value[0].hash;
      const commitFiles = await getCommitFiles(repoPath, hash);
      expect(commitFiles.isOk()).toBe(true);
      if (commitFiles.isOk()) {
        expect(commitFiles.value[0].status).toBe('deleted');
      }

      const commitDiff = await getCommitFileDiff(repoPath, hash, 'README.md');
      expect(commitDiff.isOk()).toBe(true);
      if (commitDiff.isOk()) {
        expect(commitDiff.value).toContain('-# Test');
      }
    }
  });

  test('binary file is skipped in linesAdded count', async () => {
    writeFileSync(
      resolve(repoPath, 'image.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
    );
    writeFileSync(resolve(repoPath, 'text.txt'), 'hello\n');

    const summary = await getDiffSummary(repoPath);
    expect(summary.isOk()).toBe(true);
    if (summary.isOk()) {
      expect(summary.value.total).toBe(2);
    }

    invalidateStatusCache();
    const status = await getStatusSummary(repoPath);
    expect(status.isOk()).toBe(true);
    if (status.isOk()) {
      expect(status.value.linesAdded).toBe(1); // only text.txt
    }
  });

  test('getDiffSummary truncation with maxFiles', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(resolve(repoPath, `file-${i}.txt`), `content ${i}\n`);
    }

    // Truncated
    const truncated = await getDiffSummary(repoPath, { maxFiles: 3 });
    expect(truncated.isOk()).toBe(true);
    if (truncated.isOk()) {
      expect(truncated.value.files.length).toBe(3);
      expect(truncated.value.total).toBe(10);
      expect(truncated.value.truncated).toBe(true);
    }

    // Full
    const full = await getDiffSummary(repoPath);
    expect(full.isOk()).toBe(true);
    if (full.isOk()) {
      expect(full.value.files.length).toBe(10);
      expect(full.value.truncated).toBe(false);
    }
  });

  test('getDiffSummary shows line stats for staged file', async () => {
    writeFileSync(resolve(repoPath, 'stats-file.txt'), 'line1\nline2\nline3\n');
    await stageFiles(repoPath, ['stats-file.txt']);

    const result = await getDiffSummary(repoPath);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const file = result.value.files.find((f) => f.path === 'stats-file.txt');
      expect(file).toBeDefined();
      expect(file!.staged).toBe(true);
      expect(file!.additions).toBe(3);
      expect(file!.deletions).toBe(0);
    }
  });
});
