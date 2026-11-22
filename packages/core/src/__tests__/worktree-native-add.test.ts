// Worktree creation through gitoxide (`addWorktree` in @funny/native-git):
// the worktree it makes must be the one `git worktree add` makes, the cases
// it declines must reach git, and a failure must leave nothing behind.
//
// Skipped when the native module (or a binary with `addWorktree`) is not
// loadable, so a CLI-only run never passes for the native path.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { getNativeGit } from '../git/native.js';
import { executeSync } from '../git/process.js';
import { createWorktree, DISABLE_NATIVE_WORKTREE_ADD_ENV } from '../git/worktree.js';

const TMP = resolve(tmpdir(), 'core-worktree-native-add-' + Date.now());
const native = getNativeGit();
const hasNativeAdd = typeof native?.addWorktree === 'function';
let count = 0;

function git(cwd: string, args: string[]): string {
  return executeSync('git', args, { cwd }).stdout.trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  return executeSync('git', args, { cwd, reject: false }).exitCode === 0;
}

function initRepo(): string {
  const repoPath = resolve(TMP, `case-${++count}`, 'project');
  mkdirSync(resolve(repoPath, 'src'), { recursive: true });
  git(repoPath, ['init', '-b', 'master']);
  git(repoPath, ['config', 'user.email', 'test@test.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  git(repoPath, ['config', 'gc.auto', '0']);
  writeFileSync(resolve(repoPath, 'README.md'), '# Test\n');
  writeFileSync(resolve(repoPath, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(resolve(repoPath, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(resolve(repoPath, 'run.sh'), 0o755);
  symlinkSync('README.md', resolve(repoPath, 'link.md'));
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'initial']);
  return repoPath;
}

async function withCli<T>(fn: () => Promise<T>): Promise<T> {
  process.env[DISABLE_NATIVE_WORKTREE_ADD_ENV] = '1';
  try {
    return await fn();
  } finally {
    delete process.env[DISABLE_NATIVE_WORKTREE_ADD_ENV];
  }
}

/** What a caller can observe of a worktree, minus its path and branch name. */
function snapshot(worktreePath: string) {
  return {
    head: git(worktreePath, ['rev-parse', 'HEAD']),
    index: git(worktreePath, ['ls-files', '-s']),
    status: git(worktreePath, ['status', '--porcelain']),
    readme: readFileSync(resolve(worktreePath, 'README.md'), 'utf8'),
    executable: (statSync(resolve(worktreePath, 'run.sh')).mode & 0o111) !== 0,
    symlink: git(worktreePath, ['ls-files', '-s', 'link.md']).startsWith('120000'),
    upstream: gitOk(worktreePath, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    gitFile: readFileSync(resolve(worktreePath, '.git'), 'utf8').startsWith('gitdir: '),
  };
}

describe.skipIf(!hasNativeAdd)('native worktree add', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = initRepo();
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('a new branch from HEAD gives the worktree git gives', async () => {
    const nativePath = (await createWorktree(repoPath, 'via-native'))._unsafeUnwrap();
    const cliPath = (await withCli(() => createWorktree(repoPath, 'via-cli')))._unsafeUnwrap();

    expect(snapshot(nativePath)).toEqual(snapshot(cliPath));
    expect(snapshot(nativePath).status).toBe('');
    expect(git(nativePath, ['branch', '--show-current'])).toBe('via-native');
    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).toContain(
      'branch refs/heads/via-native',
    );
    // `git worktree prune` must keep it: the registration points back at it.
    git(repoPath, ['worktree', 'prune']);
    expect(git(repoPath, ['worktree', 'list'])).toContain(nativePath);
  });

  test('the native call creates it, not the CLI fallback', async () => {
    const dest = resolve(TMP, `case-${count}`, 'direct');
    const outcome = await native!.addWorktree!(repoPath, dest, {
      branch: 'direct',
      createBranch: true,
      startPoint: 'master',
    });
    expect(outcome).toEqual({ created: true });
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(git(repoPath, ['rev-parse', 'master']));
    expect(git(repoPath, ['reflog', 'show', '--format=%gs', 'refs/heads/direct'])).toBe(
      'branch: Created from master',
    );
  });

  test('reuses an existing branch that is not checked out', async () => {
    git(repoPath, ['branch', 'existing']);
    const path = (
      await createWorktree(repoPath, 'existing', undefined, undefined, {
        reuseExistingBranch: true,
      })
    )._unsafeUnwrap();
    expect(git(path, ['branch', '--show-current'])).toBe('existing');
    expect(git(path, ['status', '--porcelain'])).toBe('');
  });

  test('declines a repository with a post-checkout hook and writes nothing', async () => {
    const hook = resolve(repoPath, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    chmodSync(hook, 0o755);
    const dest = resolve(TMP, `case-${count}`, 'hooked');

    const outcome = await native!.addWorktree!(repoPath, dest, {
      branch: 'hooked',
      createBranch: true,
    });

    expect(outcome.created).toBe(false);
    expect(outcome.unsupportedReason).toContain('post-checkout');
    expect(existsSync(dest)).toBe(false);
    expect(gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/hooked'])).toBe(false);
  });

  /** `origin` with `master` fetched into `refs/remotes/origin/master`. */
  function addOrigin(name = 'origin'): void {
    const bare = resolve(TMP, `case-${count}`, `${name}.git`);
    git(repoPath, ['init', '-q', '--bare', bare]);
    git(repoPath, ['remote', 'add', name, bare]);
    git(repoPath, ['push', '-q', name, 'master']);
    git(repoPath, ['fetch', '-q', name]);
  }

  /** `branch.<name>.*` as git reads it back. */
  function branchConfig(name: string): string {
    return executeSync('git', ['config', '--get-regexp', `^branch\\.${name}\\.`], {
      cwd: repoPath,
      reject: false,
    }).stdout.trim();
  }

  async function nativeAdd(branch: string, startPoint: string) {
    const dest = resolve(TMP, `case-${count}`, branch);
    return native!.addWorktree!(repoPath, dest, { branch, createBranch: true, startPoint });
  }

  test('a remote-tracking start point gets the upstream git gives it', async () => {
    addOrigin();
    const viaNative = (await createWorktree(repoPath, 'tracks', 'origin/master'))._unsafeUnwrap();
    const viaCli = (
      await withCli(() => createWorktree(repoPath, 'tracks-cli', 'origin/master'))
    )._unsafeUnwrap();

    expect(git(viaNative, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/master');
    expect(snapshot(viaNative)).toEqual(snapshot(viaCli));
    expect(branchConfig('tracks')).toBe(
      branchConfig('tracks-cli').replaceAll('branch.tracks-cli.', 'branch.tracks.'),
    );
  });

  test('the upstream is written by the native call itself', async () => {
    addOrigin();
    expect(await nativeAdd('direct-up', 'origin/master')).toEqual({ created: true });
    expect(branchConfig('direct-up')).toBe(
      'branch.direct-up.remote origin\nbranch.direct-up.merge refs/heads/master',
    );
  });

  test('autoSetupRebase=always adds branch.<name>.rebase', async () => {
    addOrigin();
    git(repoPath, ['config', 'branch.autoSetupRebase', 'always']);
    expect((await nativeAdd('rebases', 'origin/master')).created).toBe(true);
    expect(git(repoPath, ['config', 'branch.rebases.rebase'])).toBe('true');
  });

  test('autoSetupMerge=false and a mismatched simple mode set no upstream', async () => {
    addOrigin();
    git(repoPath, ['config', 'branch.autoSetupMerge', 'false']);
    expect((await nativeAdd('untracked', 'origin/master')).created).toBe(true);
    git(repoPath, ['config', 'branch.autoSetupMerge', 'simple']);
    expect((await nativeAdd('other-name', 'origin/master')).created).toBe(true);
    expect(branchConfig('untracked')).toBe('');
    expect(branchConfig('other-name')).toBe('');
  });

  test('autoSetupMerge=simple tracks a remote branch of the same name', async () => {
    addOrigin();
    git(repoPath, ['branch', '-m', 'master', 'main']);
    git(repoPath, ['config', 'branch.autoSetupMerge', 'simple']);
    // `refs/remotes/origin/master` exists; a new branch named `master` matches it.
    expect((await nativeAdd('master', 'origin/master')).created).toBe(true);
    expect(git(repoPath, ['config', 'branch.master.merge'])).toBe('refs/heads/master');
  });

  test('two remotes mapping onto the start point are left to git', async () => {
    addOrigin();
    git(repoPath, ['remote', 'add', 'mirror', resolve(TMP, `case-${count}`, 'origin.git')]);
    git(repoPath, ['config', 'remote.mirror.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    const outcome = await nativeAdd('ambiguous', 'origin/master');
    expect(outcome).toEqual({ created: false, unsupportedReason: 'ambiguous upstream' });
    expect(gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/ambiguous'])).toBe(
      false,
    );
  });

  test('a failed native add removes the upstream it wrote', async () => {
    addOrigin();
    const dest = resolve(TMP, `case-${count}`, 'occupied-up');
    mkdirSync(dest, { recursive: true });
    writeFileSync(resolve(dest, 'keep.txt'), 'not ours');
    await expect(
      native!.addWorktree!(repoPath, dest, {
        branch: 'doomed-up',
        createBranch: true,
        startPoint: 'origin/master',
      }),
    ).rejects.toThrow();
    expect(branchConfig('doomed-up')).toBe('');
    expect(gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/doomed-up'])).toBe(
      false,
    );
  });

  test('a failed native add removes the branch it created', async () => {
    // A non-empty destination fails after the branch was made.
    const dest = resolve(TMP, `case-${count}`, 'occupied');
    mkdirSync(dest, { recursive: true });
    writeFileSync(resolve(dest, 'keep.txt'), 'not ours');

    await expect(
      native!.addWorktree!(repoPath, dest, { branch: 'doomed', createBranch: true }),
    ).rejects.toThrow();

    expect(gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/doomed'])).toBe(false);
    expect(readFileSync(resolve(dest, 'keep.txt'), 'utf8')).toBe('not ours');
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(dest);
  });

  test('a failed native add keeps a branch that existed before', async () => {
    // `master` is checked out in the main worktree.
    const dest = resolve(TMP, `case-${count}`, 'busy');
    await expect(
      native!.addWorktree!(repoPath, dest, { branch: 'master', createBranch: false }),
    ).rejects.toThrow();
    expect(gitOk(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/master'])).toBe(true);
    expect(existsSync(resolve(dest, 'README.md'))).toBe(false);
  });
});
