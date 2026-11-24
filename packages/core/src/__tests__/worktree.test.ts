import { chmodSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { executeSync } from '../git/process.js';
import {
  checkWorktreePathInProject,
  createWorktree,
  findWorktreeForBranch,
  getWorktreeBasePath,
  listWorktrees,
  removeWorktree,
  removeBranch,
  shouldRegisterSafeDirectory,
  worktreeUnsavedWork,
} from '../git/worktree.js';

const TMP = resolve(tmpdir(), 'core-worktree-test-' + Date.now());
let testCount = 0;

// Each test gets its own directory, and the repo never starts a background gc.
// Rebuilding one shared path right after deleting it let a git process left
// over from the previous test hit the new repo ("fatal: could not parse HEAD").
function initTestRepo(): string {
  const repoPath = resolve(TMP, `test-${++testCount}`, 'project');
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  executeSync('git', ['config', 'gc.auto', '0'], { cwd: repoPath });
  executeSync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoPath });
  writeFileSync(resolve(repoPath, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: repoPath });
  executeSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
}

function branchExists(repoPath: string, branch: string): boolean {
  return (
    executeSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoPath,
      reject: false,
    }).exitCode === 0
  );
}

function registeredBranches(repoPath: string): string[] {
  return executeSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    .stdout.split('\n')
    .filter((line) => line.startsWith('branch refs/heads/'))
    .map((line) => line.slice('branch refs/heads/'.length));
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

    test('returns error for duplicate worktree and keeps the first one', async () => {
      const first = await createWorktree(repoPath, 'dup-branch');
      expect(first.isOk()).toBe(true);

      const second = await createWorktree(repoPath, 'dup-branch');
      expect(second.isErr()).toBe(true);

      // The failed attempt must not clean up the branch or worktree it did not create.
      const firstPath = first._unsafeUnwrap();
      expect(existsSync(firstPath)).toBe(true);
      expect(branchExists(repoPath, 'dup-branch')).toBe(true);
      const branches = registeredBranches(repoPath);
      expect(branches.filter((b) => b === 'dup-branch')).toHaveLength(1);
    });

    test('uses a numbered folder when a leftover folder takes the branch name', async () => {
      const leftover = resolve(getWorktreeBasePath(repoPath), 'leftover');
      mkdirSync(leftover, { recursive: true });
      writeFileSync(resolve(leftover, 'stale.txt'), 'from a worktree deleted by hand');

      const result = await createWorktree(repoPath, 'leftover');
      expect(result._unsafeUnwrap()).toBe(`${leftover}-2`);
      expect(existsSync(resolve(leftover, 'stale.txt'))).toBe(true);
    });

    test('branches that sanitize to the same folder both get a worktree', async () => {
      const slashed = (await createWorktree(repoPath, 'feat/a'))._unsafeUnwrap();
      const dashed = (await createWorktree(repoPath, 'feat-a'))._unsafeUnwrap();
      expect(slashed).not.toBe(dashed);
      expect(dashed).toBe(`${slashed}-2`);
    });

    test('a failed post-checkout hook leaves no worktree or branch behind', async () => {
      const hook = resolve(repoPath, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      chmodSync(hook, 0o755);

      const result = await createWorktree(repoPath, 'hook-fails');
      expect(result.isErr()).toBe(true);

      expect(existsSync(resolve(getWorktreeBasePath(repoPath), 'hook-fails'))).toBe(false);
      expect(registeredBranches(repoPath)).not.toContain('hook-fails');
      expect(branchExists(repoPath, 'hook-fails')).toBe(false);

      // Nothing is left to block a retry once the hook is fixed.
      rmSync(hook);
      expect((await createWorktree(repoPath, 'hook-fails')).isOk()).toBe(true);
    });

    test('creates worktree from specific base branch', async () => {
      // Get current branch name
      const branch = executeSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
      }).stdout.trim();
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

  describe('findWorktreeForBranch', () => {
    test('returns the path for a branch checked out in a worktree', async () => {
      const createResult = await createWorktree(repoPath, 'existing-branch');
      expect(createResult.isOk()).toBe(true);

      const result = await findWorktreeForBranch(repoPath, 'existing-branch');

      expect(result.isOk()).toBe(true);
      if (result.isOk() && createResult.isOk()) {
        expect(result.value).toBe(createResult.value);
      }
    });

    test('returns null when the branch is not checked out in a worktree', async () => {
      const result = await findWorktreeForBranch(repoPath, 'missing-branch');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('removeWorktree', () => {
    test('removes a worktree', async () => {
      const createResult = await createWorktree(repoPath, 'to-remove');
      if (createResult.isErr()) console.error('DEBUG ERROR:', createResult.error);
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

  // An issue-factory worktree started from whatever the local checkout had, so
  // its pull request carried the local base's unpushed commits.
  describe('createWorktree from the remote base', () => {
    function commit(cwd: string, file: string): string {
      writeFileSync(resolve(cwd, file), file);
      executeSync('git', ['add', '.'], { cwd });
      executeSync('git', ['commit', '-m', file], { cwd });
      return executeSync('git', ['rev-parse', 'HEAD'], { cwd }).stdout.trim();
    }

    /** A bare remote holding the repo's first commit, with the local base one commit ahead. */
    function withRemoteBehind(): { base: string; pushed: string; local: string } {
      const base = executeSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
      }).stdout.trim();
      const remote = resolve(repoPath, '..', 'remote.git');
      executeSync('git', ['init', '--bare', remote], { cwd: repoPath });
      executeSync('git', ['remote', 'add', 'origin', remote], { cwd: repoPath });
      executeSync('git', ['push', 'origin', base], { cwd: repoPath });
      const pushed = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).stdout.trim();
      return { base, pushed, local: commit(repoPath, 'unpushed.txt') };
    }

    const headOf = (cwd: string) =>
      executeSync('git', ['rev-parse', 'HEAD'], { cwd }).stdout.trim();

    test("starts from origin, without the local base's unpushed commits", async () => {
      const { base, pushed } = withRemoteBehind();
      const result = await createWorktree(repoPath, 'from-remote', base, undefined, {
        fromRemote: true,
      });
      const wtPath = result._unsafeUnwrap();
      expect(headOf(wtPath)).toBe(pushed);
      // The new branch does not track the base branch.
      const upstream = executeSync('git', ['config', '--get', 'branch.from-remote.merge'], {
        cwd: wtPath,
        reject: false,
      });
      expect(upstream.stdout.trim()).toBe('');
    });

    test('starts from origin even when the checkout is on another branch', async () => {
      const { base, pushed } = withRemoteBehind();
      executeSync('git', ['checkout', '-b', 'someone-elses-work'], { cwd: repoPath });
      commit(repoPath, 'other.txt');
      const result = await createWorktree(repoPath, 'from-remote-2', base, undefined, {
        fromRemote: true,
      });
      expect(headOf(result._unsafeUnwrap())).toBe(pushed);
    });

    test('fetches first: a commit pushed from elsewhere is included', async () => {
      const { base } = withRemoteBehind();
      // Move the remote ahead without the local remote-tracking ref knowing.
      const clone = resolve(repoPath, '..', 'clone');
      executeSync('git', ['clone', resolve(repoPath, '..', 'remote.git'), clone], {
        cwd: repoPath,
      });
      executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
      executeSync('git', ['config', 'user.name', 'Test'], { cwd: clone });
      const newer = commit(clone, 'from-elsewhere.txt');
      executeSync('git', ['push', 'origin', base], { cwd: clone });

      const result = await createWorktree(repoPath, 'from-remote-3', base, undefined, {
        fromRemote: true,
      });
      expect(headOf(result._unsafeUnwrap())).toBe(newer);
    });

    test('without a remote it falls back to the local base branch', async () => {
      const base = executeSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath,
      }).stdout.trim();
      const local = headOf(repoPath);
      const result = await createWorktree(repoPath, 'no-remote', base, undefined, {
        fromRemote: true,
      });
      expect(headOf(result._unsafeUnwrap())).toBe(local);
    });

    test('without fromRemote the local base is used, as before', async () => {
      const { base, local } = withRemoteBehind();
      const result = await createWorktree(repoPath, 'local-base', base);
      expect(headOf(result._unsafeUnwrap())).toBe(local);
    });
  });

  // Issue #229: the issue factory removed a worktree holding 85 uncommitted
  // files. This is what decides whether a worktree may be deleted.
  describe('worktreeUnsavedWork', () => {
    async function freshWorktree(): Promise<string> {
      const result = await createWorktree(repoPath, 'unsaved-branch');
      expect(result.isOk()).toBe(true);
      return result._unsafeUnwrap();
    }

    test('a worktree just created has nothing to lose, even off an unpushed base', async () => {
      // The test repo has no remote: its base commit is on no remote either,
      // but the base branch keeps it.
      const wtPath = await freshWorktree();
      const work = (await worktreeUnsavedWork(wtPath))._unsafeUnwrap();
      expect(work).toEqual({ dirtyFileCount: 0, unpushedCommitCount: 0 });
    });

    test('counts untracked and modified files', async () => {
      const wtPath = await freshWorktree();
      writeFileSync(resolve(wtPath, 'new-file.txt'), 'new');
      writeFileSync(resolve(wtPath, 'another.txt'), 'new');
      const work = (await worktreeUnsavedWork(wtPath))._unsafeUnwrap();
      expect(work).toEqual({ dirtyFileCount: 2, unpushedCommitCount: 0 });
    });

    test('counts commits only its branch has', async () => {
      const wtPath = await freshWorktree();
      writeFileSync(resolve(wtPath, 'committed.txt'), 'x');
      executeSync('git', ['add', '.'], { cwd: wtPath });
      executeSync('git', ['commit', '-m', 'work'], { cwd: wtPath });
      const work = (await worktreeUnsavedWork(wtPath))._unsafeUnwrap();
      expect(work).toEqual({ dirtyFileCount: 0, unpushedCommitCount: 1 });
    });

    test('a path that is not a repository is an error, not "nothing to lose"', async () => {
      const result = await worktreeUnsavedWork(resolve(TMP, `missing-${testCount}`));
      expect(result.isErr()).toBe(true);
    });
  });

  describe('removeBranch', () => {
    test('removes a branch', async () => {
      // Create a branch
      executeSync('git', ['branch', 'temp-branch'], { cwd: repoPath });

      expect((await removeBranch(repoPath, 'temp-branch')).isOk()).toBe(true);

      // Verify branch is gone
      const branches = executeSync('git', ['branch', '--list'], { cwd: repoPath }).stdout;
      expect(branches).not.toContain('temp-branch');
    });

    test('a branch that does not exist is already gone (ok)', async () => {
      expect((await removeBranch(repoPath, 'nonexistent-branch')).isOk()).toBe(true);
    });

    test('a refused deletion is an error', async () => {
      // The checked-out branch cannot be deleted.
      const current = executeSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
      }).stdout.trim();
      const result = await removeBranch(repoPath, current);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain(current);
    });

    test('refuses to act on branch names starting with - (L4 flag-injection)', async () => {
      // Create a real branch we can verify is NOT touched even though the
      // attacker tries to pass `--all` or `-rf` as the branch name.
      executeSync('git', ['branch', 'real-branch'], { cwd: repoPath });
      expect((await removeBranch(repoPath, '--all')).isErr()).toBe(true);
      expect((await removeBranch(repoPath, '-rf')).isErr()).toBe(true);
      const branches = executeSync('git', ['branch', '--list'], { cwd: repoPath }).stdout;
      // real-branch must still exist — the dash-leading inputs must have been
      // dropped without ever reaching `git branch -D`.
      expect(branches).toContain('real-branch');
    });
  });

  describe('createWorktree — branch name validation (L4)', () => {
    test('rejects branch names starting with -', async () => {
      const result = await createWorktree(repoPath, '-rf');
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toMatch(/must not start with/i);
      }
    });
  });

  /*
   * Security CR-3 — `removeWorktree` previously took `worktreePath` verbatim
   * from the request body and ran `git worktree remove -f <path>` followed
   * by an unconditional `rm -rf <path>` on failure. That let an attacker
   * delete arbitrary directories writable by the runner UID (`~/.ssh`,
   * `~/.funny/encryption.key`, etc.). The current code calls
   * `assertWorktreeInProjectBase` first; these tests pin that down.
   */
  describe('worktreePath containment (security CR-3)', () => {
    test('checkWorktreePathInProject accepts a worktree under the project base', async () => {
      const result = await createWorktree(repoPath, 'contained-1');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(checkWorktreePathInProject(repoPath, result.value)).toBeNull();
      }
    });

    test('checkWorktreePathInProject accepts only a worktree directory, not the base or deeper', async () => {
      const created = await createWorktree(repoPath, 'only-direct');
      expect(created.isOk()).toBe(true);
      if (!created.isOk()) return;
      const nested = resolve(created.value, 'src');
      mkdirSync(nested, { recursive: true });

      expect(checkWorktreePathInProject(repoPath, created.value)).toBeNull();
      expect(checkWorktreePathInProject(repoPath, resolve(created.value, '..'))).not.toBeNull();
      expect(checkWorktreePathInProject(repoPath, nested)).not.toBeNull();
    });

    test('checkWorktreePathInProject rejects /etc', () => {
      const err = checkWorktreePathInProject(repoPath, '/etc');
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/not one of the project's worktree directories/i);
    });

    test('checkWorktreePathInProject rejects leading-dash', () => {
      const err = checkWorktreePathInProject(repoPath, '-rf');
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/must not start with/i);
    });

    test('checkWorktreePathInProject rejects sibling of project (escape attempt)', () => {
      const sibling = resolve(repoPath, '..', 'other-project');
      const err = checkWorktreePathInProject(repoPath, sibling);
      expect(err).not.toBeNull();
    });

    test('removeWorktree refuses /etc — does not delete anything', async () => {
      const result = await removeWorktree(repoPath, '/etc');
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toMatch(/not one of the project's worktree directories/i);
      }
      // Sanity: /etc still exists.
      expect(existsSync('/etc')).toBe(true);
    });

    // Issue #178: the base itself passed containment, `git worktree remove`
    // refused it, and the fallback `rm -rf` deleted every worktree.
    test('removeWorktree refuses the worktree base itself — every worktree survives', async () => {
      const created = await createWorktree(repoPath, 'survivor');
      expect(created.isOk()).toBe(true);
      if (!created.isOk()) return;
      const base = resolve(created.value, '..');

      const result = await removeWorktree(repoPath, base);

      expect(result.isErr()).toBe(true);
      expect(existsSync(resolve(created.value, 'README.md'))).toBe(true);
    });

    test('removeWorktree refuses a directory inside a worktree', async () => {
      const created = await createWorktree(repoPath, 'host');
      expect(created.isOk()).toBe(true);
      if (!created.isOk()) return;
      const nested = resolve(created.value, 'src');
      mkdirSync(nested, { recursive: true });
      writeFileSync(resolve(nested, 'work.ts'), 'uncommitted work');

      const result = await removeWorktree(repoPath, nested);

      expect(result.isErr()).toBe(true);
      expect(existsSync(resolve(nested, 'work.ts'))).toBe(true);
    });

    test('removeWorktree refuses an unrelated dir even if it exists', async () => {
      // Create a sibling dir of the project; removeWorktree must refuse it.
      const sibling = resolve(repoPath, '..', 'sibling-victim');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(resolve(sibling, 'precious.txt'), 'do not delete me');
      try {
        const result = await removeWorktree(repoPath, sibling);
        expect(result.isErr()).toBe(true);
        expect(existsSync(resolve(sibling, 'precious.txt'))).toBe(true);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });
  });

  /*
   * Security HI-4 — `ensureSafeDirectory` writes the path into
   * `git config --global --add safe.directory <path>`, which is global
   * runner state. A leading-`-` value would be interpreted by `git
   * config` as a flag; a system-prefix path would persistently widen
   * what git trusts. `shouldRegisterSafeDirectory` is the pure predicate
   * that gates the gitWrite call.
   */
  describe('shouldRegisterSafeDirectory (security HI-4)', () => {
    test('accepts a normal absolute project path', () => {
      expect(shouldRegisterSafeDirectory('/home/user/projects/foo')).toBe(true);
    });

    test('accepts a Windows-style absolute path', () => {
      expect(shouldRegisterSafeDirectory('C:\\Users\\me\\proj')).toBe(true);
      expect(shouldRegisterSafeDirectory('D:/projects/foo')).toBe(true);
    });

    test('rejects leading-dash (flag injection)', () => {
      expect(shouldRegisterSafeDirectory('-rf')).toBe(false);
      expect(shouldRegisterSafeDirectory('--exec=cmd')).toBe(false);
      expect(shouldRegisterSafeDirectory('-c')).toBe(false);
    });

    test('rejects empty / non-string', () => {
      expect(shouldRegisterSafeDirectory('')).toBe(false);
      expect(shouldRegisterSafeDirectory(undefined)).toBe(false);
      expect(shouldRegisterSafeDirectory(null)).toBe(false);
    });

    test('rejects null byte', () => {
      expect(shouldRegisterSafeDirectory('/home/user/proj\0extra')).toBe(false);
    });

    test('rejects non-absolute paths', () => {
      expect(shouldRegisterSafeDirectory('relative/path')).toBe(false);
      expect(shouldRegisterSafeDirectory('./foo')).toBe(false);
    });

    test('rejects system-prefix paths', () => {
      for (const p of [
        '/etc',
        '/etc/passwd',
        '/proc/1',
        '/sys',
        '/dev/null',
        '/run/foo',
        '/boot/grub',
        '/root/.ssh',
      ]) {
        expect(shouldRegisterSafeDirectory(p)).toBe(false);
      }
    });

    test('accepts /etcetera (not /etc) — prefix match must check separator', () => {
      // Sanity: prevent over-broad rejection.
      expect(shouldRegisterSafeDirectory('/etcetera')).toBe(true);
      expect(shouldRegisterSafeDirectory('/var-extended')).toBe(true);
    });
  });
});
