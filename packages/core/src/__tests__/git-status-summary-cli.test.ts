// Characterization tests for the CLI fallback of getStatusSummary. Pins the
// CLI path at module load so every branch of the porcelain / numstat parsing,
// upstream counting, base-branch fallback, and merge detection is exercised.
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getStatusSummary, invalidateStatusCache } from '../git/index.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-status-cli-' + Date.now());

function run(cwd: string, args: string[]): string {
  return executeSync('git', args, { cwd }).stdout.trim();
}

function initRepo(name: string, commit = true): string {
  const repoPath = resolve(TMP, name);
  mkdirSync(repoPath, { recursive: true });
  run(repoPath, ['init', '-b', 'master']);
  run(repoPath, ['config', 'user.email', 'test@test.com']);
  run(repoPath, ['config', 'user.name', 'Test']);
  if (commit) {
    writeFileSync(resolve(repoPath, 'base.txt'), 'a\nb\nc\n');
    commitAll(repoPath, 'init');
  }
  return repoPath;
}

function commitAll(repoPath: string, message: string): void {
  run(repoPath, ['add', '-A']);
  run(repoPath, ['commit', '-m', message]);
}

async function summary(cwd: string, baseBranch?: string, projectCwd?: string) {
  invalidateStatusCache();
  const result = await getStatusSummary(cwd, baseBranch, projectCwd);
  if (result.isErr()) throw new Error(String(result.error));
  return result.value;
}

const CLEAN = {
  dirtyFileCount: 0,
  unpushedCommitCount: 0,
  unpulledCommitCount: 0,
  hasRemoteBranch: false,
  isMergedIntoBase: false,
  linesAdded: 0,
  linesDeleted: 0,
};

describe('getStatusSummary (CLI fallback)', () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => {
    invalidateStatusCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('clean repo without base branch', async () => {
    const repo = initRepo('clean');
    expect(await summary(repo)).toEqual(CLEAN);
  });

  test('tracked edits, deletions, and untracked dirs expanded by ls-files', async () => {
    const repo = initRepo('dirty');
    writeFileSync(resolve(repo, 'base.txt'), 'a\nX\nc\nd\n'); // +2 -1
    mkdirSync(resolve(repo, 'dir'));
    writeFileSync(resolve(repo, 'dir/one.txt'), '1\n2\n'); // +2
    writeFileSync(resolve(repo, 'dir/two.txt'), '1\n'); // +1
    // ls-files quotes this name and the quoted form is passed through as-is, so
    // its lines are not counted (current behavior, characterized here).
    writeFileSync(resolve(repo, 'sp "q".txt'), 'q\n');
    writeFileSync(resolve(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0])); // binary
    expect(await summary(repo)).toEqual({
      ...CLEAN,
      dirtyFileCount: 5,
      linesAdded: 5,
      linesDeleted: 1,
    });
  });

  test('binary tracked change ("-" numstat) is ignored', async () => {
    const repo = initRepo('binary');
    writeFileSync(resolve(repo, 'b.bin'), Buffer.from([0, 1, 2, 0]));
    commitAll(repo, 'bin');
    writeFileSync(resolve(repo, 'b.bin'), Buffer.from([0, 3, 4, 0, 5]));
    expect(await summary(repo)).toEqual({ ...CLEAN, dirtyFileCount: 1 });
  });

  test('detached HEAD returns the early no-branch summary', async () => {
    const repo = initRepo('detached');
    writeFileSync(resolve(repo, 'more.txt'), 'm\n');
    commitAll(repo, 'second');
    run(repo, ['checkout', '--detach', 'HEAD~1']);
    writeFileSync(resolve(repo, 'base.txt'), 'a\nb\nc\nd\n');
    expect(await summary(repo, 'master', repo)).toEqual({
      ...CLEAN,
      dirtyFileCount: 1,
      linesAdded: 1,
    });
  });

  test('empty repo with no commits ("No commits yet on")', async () => {
    const repo = initRepo('empty', false);
    writeFileSync(resolve(repo, 'new.txt'), 'x\ny\n');
    expect(await summary(repo, 'master', repo)).toEqual({
      ...CLEAN,
      dirtyFileCount: 1,
      linesAdded: 2,
    });
  });

  test('feature branch without remote: base count and base diff fallback', async () => {
    const repo = initRepo('feature');
    run(repo, ['checkout', '-b', 'feature']);
    writeFileSync(resolve(repo, 'base.txt'), 'a\nc\nz\ny\n'); // +2 -1
    commitAll(repo, 'f1');
    writeFileSync(resolve(repo, 'f2.txt'), '1\n');
    commitAll(repo, 'f2');
    expect(await summary(repo, 'master', repo)).toEqual({
      ...CLEAN,
      unpushedCommitCount: 2,
      linesAdded: 3,
      linesDeleted: 1,
    });
    // Without projectCwd the base count still applies but no merge check.
    expect(await summary(repo, 'master')).toEqual({
      ...CLEAN,
      unpushedCommitCount: 2,
      linesAdded: 3,
      linesDeleted: 1,
    });
  });

  test('working-tree stats take priority over base diff', async () => {
    const repo = initRepo('wt-priority');
    run(repo, ['checkout', '-b', 'feature']);
    writeFileSync(resolve(repo, 'f.txt'), '1\n2\n3\n');
    commitAll(repo, 'f');
    writeFileSync(resolve(repo, 'base.txt'), 'a\nb\n'); // -1
    expect(await summary(repo, 'master', repo)).toEqual({
      ...CLEAN,
      dirtyFileCount: 1,
      unpushedCommitCount: 1,
      linesDeleted: 1,
    });
  });

  test('branch merged into base (ancestor) keeps isMergedIntoBase false', async () => {
    const repo = initRepo('merged');
    run(repo, ['checkout', '-b', 'feature']);
    writeFileSync(resolve(repo, 'f.txt'), '1\n');
    commitAll(repo, 'f');
    run(repo, ['checkout', 'master']);
    run(repo, ['merge', '--no-ff', '-m', 'merge', 'feature']);
    run(repo, ['checkout', 'feature']);
    expect(await summary(repo, 'master', repo)).toEqual(CLEAN);
  });

  test('upstream tracking: ahead and behind counts', async () => {
    const origin = initRepo('origin');
    const clone = resolve(TMP, 'clone');
    executeSync('git', ['clone', origin, clone], { cwd: TMP });
    run(clone, ['config', 'user.email', 'test@test.com']);
    run(clone, ['config', 'user.name', 'Test']);

    writeFileSync(resolve(origin, 'remote.txt'), 'r\n');
    commitAll(origin, 'remote change');
    run(clone, ['fetch']);

    writeFileSync(resolve(clone, 'local.txt'), 'l\n');
    commitAll(clone, 'local 1');
    writeFileSync(resolve(clone, 'local2.txt'), 'l\n');
    commitAll(clone, 'local 2');

    expect(await summary(clone, 'master', clone)).toEqual({
      ...CLEAN,
      hasRemoteBranch: true,
      unpushedCommitCount: 2,
      unpulledCommitCount: 1,
    });
    expect(await summary(clone)).toEqual({
      ...CLEAN,
      hasRemoteBranch: true,
      unpushedCommitCount: 2,
      unpulledCommitCount: 1,
    });
  });
});
