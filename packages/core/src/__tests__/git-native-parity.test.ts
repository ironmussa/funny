// Parity tests: assert the native (gitoxide) path produces the same results
// as the CLI fallback for the same fixture. Toggles FUNNY_DISABLE_NATIVE_GIT
// per call, so unlike git.test.ts / git-integration.test.ts (which pin the
// CLI path at module load), this suite exercises both code paths.
//
// If @funny/native-git isn't built/loadable, the suite is skipped — never
// silently degrades to a CLI-only run that wouldn't catch native regressions.

import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'vitest';

import { getCommittedBranchSummary, getDiffSummary, stageFiles } from '../git/index.js';
import { getNativeGit } from '../git/native.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-native-parity-' + Date.now());

function initRepo(name = 'repo'): string {
  const repoPath = resolve(TMP, name);
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init', '-b', 'master'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  return repoPath;
}

function commitAll(repoPath: string, message: string): void {
  executeSync('git', ['add', '-A'], { cwd: repoPath });
  executeSync('git', ['commit', '-m', message], { cwd: repoPath });
}

async function runCli<T>(fn: () => Promise<T>): Promise<T> {
  process.env.FUNNY_DISABLE_NATIVE_GIT = '1';
  try {
    return await fn();
  } finally {
    delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  }
}

async function runNative<T>(fn: () => Promise<T>): Promise<T> {
  delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  return fn();
}

// Load native at module load (before any env-var toggling) so getNativeGit()'s
// require runs with FUNNY_DISABLE_NATIVE_GIT unset. Subsequent calls re-check
// the env on every invocation and respect the toggle. Done synchronously so
// `describe.skipIf` sees the resolved value at registration time.
delete process.env.FUNNY_DISABLE_NATIVE_GIT;
const nativeAvailable = getNativeGit() !== null;
if (!nativeAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[parity] @funny/native-git unavailable — skipping suite');
}

describe.skipIf(!nativeAvailable)('native vs CLI parity', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  });

  // ─── getDiffSummary ──────────────────────────────────────────

  test('getDiffSummary: modified, untracked, deleted, staged-modified, staged-added', async () => {
    const repo = initRepo();
    // Initial: 3 tracked files
    writeFileSync(resolve(repo, 'mod.txt'), 'a\nb\nc\nd\ne\n');
    writeFileSync(resolve(repo, 'del.txt'), 'will be deleted\n');
    writeFileSync(resolve(repo, 'staged-mod.txt'), '1\n2\n3\n4\n');
    commitAll(repo, 'initial');

    // Mutate: modify worktree, delete one file, stage a modification, add untracked, stage new file
    writeFileSync(resolve(repo, 'mod.txt'), 'a\nb\nc\nd\ne\nf\ng\n'); // +2 unstaged
    unlinkSync(resolve(repo, 'del.txt'));
    writeFileSync(resolve(repo, 'staged-mod.txt'), '1\n2\n3\n4\n5\n'); // +1
    executeSync('git', ['add', 'staged-mod.txt'], { cwd: repo });
    writeFileSync(resolve(repo, 'untracked.txt'), 'u1\nu2\nu3\n');
    writeFileSync(resolve(repo, 'staged-new.txt'), 's1\ns2\n');
    executeSync('git', ['add', 'staged-new.txt'], { cwd: repo });

    const cli = await runCli(() => getDiffSummary(repo));
    const native = await runNative(() => getDiffSummary(repo));

    expect(cli.isOk()).toBe(true);
    expect(native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    // Same total file count
    expect(native.value.total).toBe(cli.value.total);

    // Build path-keyed maps and compare entry by entry
    const byPath = (xs: typeof cli.value.files) =>
      Object.fromEntries(xs.map((f) => [`${f.path}|${f.staged}`, f]));
    const cliMap = byPath(cli.value.files);
    const natMap = byPath(native.value.files);

    expect(Object.keys(natMap).sort()).toEqual(Object.keys(cliMap).sort());

    for (const key of Object.keys(cliMap)) {
      const c = cliMap[key];
      const n = natMap[key];
      expect(n.path).toBe(c.path);
      expect(n.staged).toBe(c.staged);
      expect(n.status).toBe(c.status);
      expect(n.additions ?? 0).toBe(c.additions ?? 0);
      expect(n.deletions ?? 0).toBe(c.deletions ?? 0);
    }
  });

  test('getDiffSummary: clean repo returns no files', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');

    const cli = await runCli(() => getDiffSummary(repo));
    const native = await runNative(() => getDiffSummary(repo));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (cli.isOk() && native.isOk()) {
      expect(cli.value.total).toBe(0);
      expect(native.value.total).toBe(0);
    }
  });

  test('getDiffSummary: stageFiles uses native check-ignore (no panic on ignored paths)', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, '.gitignore'), '*.log\nnode_modules/\n');
    writeFileSync(resolve(repo, 'kept.txt'), 'k\n');
    commitAll(repo, 'init');

    writeFileSync(resolve(repo, 'kept.txt'), 'k\nupdated\n');
    writeFileSync(resolve(repo, 'app.log'), 'noise\n'); // ignored
    writeFileSync(resolve(repo, 'kept-also.txt'), 'new\n');

    // Stage a mix; ignored paths must not abort the operation under either path.
    const cli = await runCli(() => stageFiles(repo, ['kept.txt', 'app.log', 'kept-also.txt']));
    expect(cli.isOk()).toBe(true);

    // Reset and try with native
    executeSync('git', ['reset', 'HEAD'], { cwd: repo });
    const native = await runNative(() =>
      stageFiles(repo, ['kept.txt', 'app.log', 'kept-also.txt']),
    );
    expect(native.isOk()).toBe(true);

    // Both runs should leave kept.txt + kept-also.txt staged, app.log ignored.
    const summary = await runCli(() => getDiffSummary(repo));
    if (summary.isOk()) {
      const stagedPaths = summary.value.files
        .filter((f) => f.staged)
        .map((f) => f.path)
        .sort();
      expect(stagedPaths).toEqual(['kept-also.txt', 'kept.txt']);
    }
  });

  // ─── getCommittedBranchSummary ───────────────────────────────

  test('getCommittedBranchSummary: branch ahead of base, not merged', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), '1\n2\n3\n');
    commitAll(repo, 'base');

    executeSync('git', ['checkout', '-b', 'feature'], { cwd: repo });
    writeFileSync(resolve(repo, 'a.txt'), '1\n2\n3\n4\n5\n'); // +2
    writeFileSync(resolve(repo, 'b.txt'), 'new\nfile\nthree\nfour\n'); // +4
    commitAll(repo, 'feature commit');

    const cli = await runCli(() => getCommittedBranchSummary(repo, 'master', 'feature'));
    const native = await runNative(() => getCommittedBranchSummary(repo, 'master', 'feature'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.linesAdded).toBe(cli.value.linesAdded);
    expect(native.value.linesDeleted).toBe(cli.value.linesDeleted);
    expect(native.value.unpushedCommitCount).toBe(cli.value.unpushedCommitCount);
    expect(native.value.unpulledCommitCount).toBe(cli.value.unpulledCommitCount);
    expect(native.value.hasRemoteBranch).toBe(cli.value.hasRemoteBranch);
    expect(native.value.isMergedIntoBase).toBe(cli.value.isMergedIntoBase);

    // Sanity: 6 lines added (2 + 4), not merged
    expect(native.value.linesAdded).toBe(6);
    expect(native.value.isMergedIntoBase).toBe(false);
    expect(native.value.unpushedCommitCount).toBe(1);
  });

  test('getCommittedBranchSummary: fully-merged branch reports isMergedIntoBase=true', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'base');

    executeSync('git', ['checkout', '-b', 'feature'], { cwd: repo });
    writeFileSync(resolve(repo, 'b.txt'), 'y\n');
    commitAll(repo, 'feature');

    executeSync('git', ['checkout', 'master'], { cwd: repo });
    executeSync('git', ['merge', '--no-ff', 'feature', '-m', 'merge feature'], { cwd: repo });

    const cli = await runCli(() => getCommittedBranchSummary(repo, 'master', 'feature'));
    const native = await runNative(() => getCommittedBranchSummary(repo, 'master', 'feature'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.isMergedIntoBase).toBe(true);
    expect(cli.value.isMergedIntoBase).toBe(true);
    // After merge, feature still differs from master (master has the merge commit
    // ahead). Both paths should agree.
    expect(native.value.linesAdded).toBe(cli.value.linesAdded);
    expect(native.value.linesDeleted).toBe(cli.value.linesDeleted);
  });

  test('getCommittedBranchSummary: identical branches report 0 lines, 0 commits ahead', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'base');
    executeSync('git', ['checkout', '-b', 'twin'], { cwd: repo });

    const cli = await runCli(() => getCommittedBranchSummary(repo, 'master', 'twin'));
    const native = await runNative(() => getCommittedBranchSummary(repo, 'master', 'twin'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.linesAdded).toBe(0);
    expect(native.value.linesDeleted).toBe(0);
    expect(native.value.unpushedCommitCount).toBe(0);
    expect(native.value.isMergedIntoBase).toBe(true); // tip(base) == tip(twin)
    expect(cli.value.isMergedIntoBase).toBe(true);
  });
});
