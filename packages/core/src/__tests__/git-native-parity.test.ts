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

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
  getCommitBody,
  getCommitFileDiff,
  getCommitFiles,
  getCommittedBranchSummary,
  getDiffSummary,
  getFullContextFileDiff,
  getLog,
  getSingleFileDiff,
  getStatusSummary,
  invalidateStatusCache,
  stageFiles,
  stashFileDiff,
  stashList,
  stashShow,
} from '../git/index.js';
import { getNativeGit } from '../git/native.js';
import { executeSync, gitRead } from '../git/process.js';

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

/** Count +/- lines in unified diff output (excluding file headers). */
function countUnifiedDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

async function cliCheckIgnore(cwd: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const result = await gitRead(['check-ignore', '--stdin'], {
    cwd,
    reject: false,
    stdin: paths.join('\n'),
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split('\n')
    .map((p) => p.trim());
}

async function cliListUnmergedFiles(cwd: string): Promise<string[]> {
  const result = await gitRead(['ls-files', '--unmerged'], { cwd, reject: false });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const paths = result.stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\t').pop() ?? '')
    .filter(Boolean);
  return [...new Set(paths)].sort();
}

async function nativeCheckIgnore(cwd: string, paths: string[]): Promise<string[]> {
  delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  const native = getNativeGit();
  if (!native) throw new Error('native module unavailable');
  return native.checkIgnore(cwd, paths);
}

async function nativeListUnmergedFiles(cwd: string): Promise<string[]> {
  delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  const native = getNativeGit();
  if (!native) throw new Error('native module unavailable');
  return (await native.listUnmergedFiles(cwd)).slice().sort();
}

function initMergeConflict(repo: string): void {
  writeFileSync(resolve(repo, 'conflict.txt'), 'base\n');
  commitAll(repo, 'base');
  executeSync('git', ['checkout', '-b', 'feature'], { cwd: repo });
  writeFileSync(resolve(repo, 'conflict.txt'), 'base\nfeature\n');
  commitAll(repo, 'feature commit');
  executeSync('git', ['checkout', 'master'], { cwd: repo });
  writeFileSync(resolve(repo, 'conflict.txt'), 'base\nmaster\n');
  commitAll(repo, 'master commit');
  executeSync('git', ['merge', 'feature'], { cwd: repo, reject: false });
}

/** Keep in sync with HEAVY_DIRS in packages/native-git/src/list_files.rs */
const HEAVY_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vite',
  '.parcel-cache',
  '.git',
  'Library',
  'Temp',
  'Logs',
  'target',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
]);

function isUnderHeavyDir(path: string): boolean {
  return path.split('/').some((seg) => HEAVY_DIRS.has(seg));
}

async function cliListFiles(cwd: string): Promise<string[]> {
  const [tracked, ignored] = await Promise.all([
    gitRead(['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      reject: false,
    }),
    gitRead(['ls-files', '--others', '--ignored', '--exclude-standard'], {
      cwd,
      reject: false,
    }),
  ]);

  const out = new Set<string>();
  if (tracked.exitCode === 0) {
    for (const line of tracked.stdout.split('\n')) {
      const f = line.trim();
      if (f && !isUnderHeavyDir(f)) out.add(f);
    }
  }
  if (ignored.exitCode === 0) {
    for (const line of ignored.stdout.split('\n')) {
      const f = line.trim();
      if (f && !isUnderHeavyDir(f)) out.add(f);
    }
  }
  return [...out].sort();
}

async function nativeListFiles(cwd: string): Promise<string[]> {
  delete process.env.FUNNY_DISABLE_NATIVE_GIT;
  const native = getNativeGit();
  if (!native) throw new Error('native module unavailable');
  return (await native.listFiles(cwd, { includeIgnored: true })).slice().sort();
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

  test('getCommittedBranchSummary: branch with deletions matches CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), '1\n2\n3\n');
    writeFileSync(resolve(repo, 'b.txt'), 'x\ny\n');
    commitAll(repo, 'base');

    executeSync('git', ['checkout', '-b', 'feature'], { cwd: repo });
    writeFileSync(resolve(repo, 'a.txt'), '1\n2\n3\n4\n'); // +1
    unlinkSync(resolve(repo, 'b.txt')); // -2
    commitAll(repo, 'feature with deletion');

    const cli = await runCli(() => getCommittedBranchSummary(repo, 'master', 'feature'));
    const native = await runNative(() => getCommittedBranchSummary(repo, 'master', 'feature'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.linesAdded).toBe(cli.value.linesAdded);
    expect(native.value.linesDeleted).toBe(cli.value.linesDeleted);
    expect(native.value.linesAdded).toBe(1);
    expect(native.value.linesDeleted).toBe(2);
  });

  // ─── getStatusSummary ────────────────────────────────────────

  test('getStatusSummary: dirty count and line stats match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'tracked.txt'), 'a\nb\nc\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'tracked.txt'), 'a\nb\nc\nd\ne\n'); // +2
    writeFileSync(resolve(repo, 'new.txt'), 'x\ny\nz\n'); // +3 untracked

    invalidateStatusCache(repo);
    const cli = await runCli(() => getStatusSummary(repo));
    invalidateStatusCache(repo);
    const native = await runNative(() => getStatusSummary(repo));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.dirtyFileCount).toBe(cli.value.dirtyFileCount);
    expect(native.value.linesAdded).toBe(cli.value.linesAdded);
    expect(native.value.linesDeleted).toBe(cli.value.linesDeleted);
    expect(native.value.dirtyFileCount).toBe(2);
    expect(native.value.linesAdded).toBe(5);
  });

  test('getStatusSummary: excludes binary untracked files from line counts', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'text.txt'), 'a\n');
    commitAll(repo, 'init');

    writeFileSync(resolve(repo, 'text.txt'), 'a\nb\n');
    writeFileSync(resolve(repo, 'binary.bin'), Buffer.from([0, 1, 2, 0]));

    invalidateStatusCache(repo);
    const cli = await runCli(() => getStatusSummary(repo));
    invalidateStatusCache(repo);
    const native = await runNative(() => getStatusSummary(repo));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.linesAdded).toBe(cli.value.linesAdded);
    expect(native.value.linesDeleted).toBe(cli.value.linesDeleted);
    expect(native.value.linesAdded).toBe(1);
  });

  // ─── getCommitFiles ──────────────────────────────────────────

  test('getCommitFiles: added, modified, deleted entries match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'keep.txt'), 'old\n');
    writeFileSync(resolve(repo, 'gone.txt'), 'bye\n');
    commitAll(repo, 'init');

    writeFileSync(resolve(repo, 'keep.txt'), 'old\nnew\n');
    unlinkSync(resolve(repo, 'gone.txt'));
    writeFileSync(resolve(repo, 'added.txt'), 'added\n');
    commitAll(repo, 'second');

    const hash = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();

    const cli = await runCli(() => getCommitFiles(repo, hash));
    const native = await runNative(() => getCommitFiles(repo, hash));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    const byPath = (files: typeof cli.value) => Object.fromEntries(files.map((f) => [f.path, f]));
    const cliMap = byPath(cli.value);
    const natMap = byPath(native.value);

    expect(Object.keys(natMap).sort()).toEqual(Object.keys(cliMap).sort());
    for (const path of Object.keys(cliMap)) {
      expect(natMap[path].status).toBe(cliMap[path].status);
      expect(natMap[path].additions).toBe(cliMap[path].additions);
      expect(natMap[path].deletions).toBe(cliMap[path].deletions);
    }
  });

  // ─── getDiffSummary (edge cases) ─────────────────────────────

  test('getDiffSummary: binary gitattributes yields zero line counts', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, '.gitattributes'), '*.bin binary\n');
    writeFileSync(resolve(repo, 'text.txt'), 'hello\n');
    commitAll(repo, 'init');

    writeFileSync(resolve(repo, 'text.txt'), 'hello\nworld\n');
    writeFileSync(resolve(repo, 'data.bin'), Buffer.from([0, 1, 2, 3, 0]));

    const cli = await runCli(() => getDiffSummary(repo));
    const native = await runNative(() => getDiffSummary(repo));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    const byPath = (files: typeof cli.value.files) =>
      Object.fromEntries(files.map((f) => [f.path, f]));
    const cliMap = byPath(cli.value.files);
    const natMap = byPath(native.value.files);

    expect(Object.keys(natMap).sort()).toEqual(Object.keys(cliMap).sort());
    for (const path of Object.keys(cliMap)) {
      expect(natMap[path].additions ?? 0).toBe(cliMap[path].additions ?? 0);
      expect(natMap[path].deletions ?? 0).toBe(cliMap[path].deletions ?? 0);
    }

    const binary = natMap['data.bin'];
    expect(binary?.additions ?? 0).toBe(0);
    expect(binary?.deletions ?? 0).toBe(0);
    expect(natMap['text.txt']?.additions).toBe(1);
  });

  // ─── getSingleFileDiff ───────────────────────────────────────

  test('getSingleFileDiff: unstaged modification hunk counts match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\nd\n');

    const cli = await runCli(() => getSingleFileDiff(repo, 'file.txt', false));
    const native = await runNative(() => getSingleFileDiff(repo, 'file.txt', false));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(countUnifiedDiffLines(native.value)).toEqual(countUnifiedDiffLines(cli.value));
    expect(countUnifiedDiffLines(native.value).additions).toBe(1);
  });

  test('getSingleFileDiff: staged modification hunk counts match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\nd\ne\n');
    executeSync('git', ['add', 'file.txt'], { cwd: repo });

    const cli = await runCli(() => getSingleFileDiff(repo, 'file.txt', true));
    const native = await runNative(() => getSingleFileDiff(repo, 'file.txt', true));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(countUnifiedDiffLines(native.value)).toEqual(countUnifiedDiffLines(cli.value));
    expect(countUnifiedDiffLines(native.value).additions).toBe(2);
  });

  // ─── getLog / getCommitBody ──────────────────────────────────

  test('getLog: commit metadata matches CLI (excluding relativeDate)', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'first');
    writeFileSync(resolve(repo, 'b.txt'), 'b\n');
    commitAll(repo, 'second');

    const cli = await runCli(() => getLog(repo, 2));
    const native = await runNative(() => getLog(repo, 2));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.length).toBe(cli.value.length);
    for (let i = 0; i < cli.value.length; i++) {
      expect(native.value[i].hash).toBe(cli.value[i].hash);
      expect(native.value[i].shortHash).toBe(cli.value[i].shortHash);
      expect(native.value[i].author).toBe(cli.value[i].author);
      expect(native.value[i].message).toBe(cli.value[i].message);
      expect(native.value[i].body).toBe(cli.value[i].body);
    }
  });

  test('getCommitBody: multi-paragraph body matches CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'a.txt'), 'a\n');
    executeSync('git', ['add', 'a.txt'], { cwd: repo });
    executeSync(
      'git',
      ['commit', '-m', 'subject line', '-m', 'body paragraph one', '-m', 'body paragraph two'],
      { cwd: repo },
    );
    const hash = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();

    const cli = await runCli(() => getCommitBody(repo, hash));
    const native = await runNative(() => getCommitBody(repo, hash));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value).toBe(cli.value);
    expect(native.value).toContain('body paragraph one');
    expect(native.value).toContain('body paragraph two');
  });

  // ─── checkIgnore / listUnmergedFiles ─────────────────────────

  test('checkIgnore: ignored paths match git check-ignore', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, '.gitignore'), '*.log\nbuild/\n');
    writeFileSync(resolve(repo, 'kept.txt'), 'k\n');
    commitAll(repo, 'init');

    const paths = ['kept.txt', 'debug.log', 'build/out.txt', 'also.txt'];
    const cli = await runCli(async () => cliCheckIgnore(repo, paths));
    const native = await nativeCheckIgnore(repo, paths);

    expect(native.sort()).toEqual(cli.sort());
    expect(new Set(native)).toEqual(new Set(['debug.log', 'build/out.txt']));
  });

  test('listUnmergedFiles: merge conflict paths match git ls-files --unmerged', async () => {
    const repo = initRepo();
    initMergeConflict(repo);

    const cli = await runCli(async () => cliListUnmergedFiles(repo));
    const native = await nativeListUnmergedFiles(repo);

    expect(native).toEqual(cli);
    expect(native).toEqual(['conflict.txt']);
  });

  // ─── stash ───────────────────────────────────────────────────

  test('stashShow: stashed file stats match git stash show --numstat', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'stashed.txt'), 'before\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'stashed.txt'), 'before\nafter\n');
    writeFileSync(resolve(repo, 'extra.txt'), 'new\n');
    executeSync('git', ['stash', 'push', '-m', 'parity stash', '--', 'stashed.txt', 'extra.txt'], {
      cwd: repo,
      reject: false,
    });

    const cli = await runCli(() => stashShow(repo, 'stash@{0}'));
    const native = await runNative(() => stashShow(repo, 'stash@{0}'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    const byPath = (files: typeof cli.value) => Object.fromEntries(files.map((f) => [f.path, f]));
    const cliMap = byPath(cli.value);
    const natMap = byPath(native.value);

    expect(Object.keys(natMap).sort()).toEqual(Object.keys(cliMap).sort());
    for (const path of Object.keys(cliMap)) {
      expect(natMap[path].additions).toBe(cliMap[path].additions);
      expect(natMap[path].deletions).toBe(cliMap[path].deletions);
    }
  });

  test('stashFileDiff: stashed file hunk counts match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'stashed.txt'), 'line1\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'stashed.txt'), 'line1\nline2\nline3\n');
    executeSync('git', ['stash', 'push', '-m', 'parity stash', '--', 'stashed.txt'], {
      cwd: repo,
      reject: false,
    });

    const cli = await runCli(() => stashFileDiff(repo, 'stash@{0}', 'stashed.txt'));
    const native = await runNative(() => stashFileDiff(repo, 'stash@{0}', 'stashed.txt'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(countUnifiedDiffLines(native.value)).toEqual(countUnifiedDiffLines(cli.value));
    expect(countUnifiedDiffLines(native.value).additions).toBe(2);
  });

  // ─── getFullContextFileDiff / getCommitFileDiff ──────────────

  test('getFullContextFileDiff: unstaged modification hunk counts match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\nd\ne\n');

    const cli = await runCli(() => getFullContextFileDiff(repo, 'file.txt', false));
    const native = await runNative(() => getFullContextFileDiff(repo, 'file.txt', false));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(countUnifiedDiffLines(native.value)).toEqual(countUnifiedDiffLines(cli.value));
    expect(countUnifiedDiffLines(native.value).additions).toBe(2);
  });

  test('getCommitFileDiff: commit file hunk counts match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'file.txt'), 'a\nb\nc\nd\ne\n');
    commitAll(repo, 'second');
    const hash = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();

    const cli = await runCli(() => getCommitFileDiff(repo, hash, 'file.txt'));
    const native = await runNative(() => getCommitFileDiff(repo, hash, 'file.txt'));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(countUnifiedDiffLines(native.value)).toEqual(countUnifiedDiffLines(cli.value));
    expect(countUnifiedDiffLines(native.value).additions).toBe(2);
  });

  // ─── stashList ───────────────────────────────────────────────

  test('stashList: stash index and message match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'tracked.txt'), 'v1\n');
    commitAll(repo, 'init');
    writeFileSync(resolve(repo, 'tracked.txt'), 'v1\nv2\n');
    executeSync('git', ['stash', 'push', '-m', 'first stash'], { cwd: repo, reject: false });
    writeFileSync(resolve(repo, 'tracked.txt'), 'v1\nv2\nv3\n');
    executeSync('git', ['stash', 'push', '-m', 'second stash'], { cwd: repo, reject: false });

    const cli = await runCli(() => stashList(repo));
    const native = await runNative(() => stashList(repo));

    expect(cli.isOk() && native.isOk()).toBe(true);
    if (!cli.isOk() || !native.isOk()) return;

    expect(native.value.length).toBe(cli.value.length);
    expect(native.value.length).toBe(2);
    for (let i = 0; i < cli.value.length; i++) {
      expect(native.value[i].index).toBe(cli.value[i].index);
      expect(native.value[i].message).toBe(cli.value[i].message);
    }
  });

  // ─── listFiles ───────────────────────────────────────────────

  test('listFiles: tracked, ignored, and heavy-dir filtering match CLI', async () => {
    const repo = initRepo();
    writeFileSync(resolve(repo, 'src.ts'), 'export {};\n');
    writeFileSync(resolve(repo, '.gitignore'), 'node_modules\nLibrary\n.env\n');
    writeFileSync(resolve(repo, '.env'), 'SECRET=1\n');
    mkdirSync(resolve(repo, 'node_modules/pkg'), { recursive: true });
    writeFileSync(resolve(repo, 'node_modules/pkg/index.js'), 'noop\n');
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src/app.ts'), 'app\n');
    commitAll(repo, 'init');

    const cli = await runCli(async () => cliListFiles(repo));
    const native = await nativeListFiles(repo);

    expect(native).toEqual(cli);
    expect(native).toContain('src.ts');
    expect(native).toContain('.env');
    expect(native).toContain('src/app.ts');
    expect(native.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });
});
