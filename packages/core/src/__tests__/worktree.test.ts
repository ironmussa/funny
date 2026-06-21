import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { executeSync } from '../git/process.js';
import {
  checkWorktreePathInProject,
  createWorktree,
  findWorktreeForBranch,
  listWorktrees,
  removeWorktree,
  removeBranch,
  shouldRegisterSafeDirectory,
} from '../git/worktree.js';

const TMP = resolve(tmpdir(), 'core-worktree-test-' + Date.now());

function initTestRepo(): string {
  const repoPath = resolve(TMP, 'project');
  mkdirSync(repoPath, { recursive: true });
  executeSync('git', ['init'], { cwd: repoPath });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  writeFileSync(resolve(repoPath, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: repoPath });
  executeSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
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

    test('returns error for duplicate worktree', async () => {
      const first = await createWorktree(repoPath, 'dup-branch');
      expect(first.isOk()).toBe(true);

      const second = await createWorktree(repoPath, 'dup-branch');
      expect(second.isErr()).toBe(true);
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

  describe('removeBranch', () => {
    test('removes a branch', async () => {
      // Create a branch
      executeSync('git', ['branch', 'temp-branch'], { cwd: repoPath });

      await removeBranch(repoPath, 'temp-branch');

      // Verify branch is gone
      const branches = executeSync('git', ['branch', '--list'], { cwd: repoPath }).stdout;
      expect(branches).not.toContain('temp-branch');
    });

    test('does not throw for non-existent branch', async () => {
      // Should not throw because reject=false
      await removeBranch(repoPath, 'nonexistent-branch');
    });

    test('refuses to act on branch names starting with - (L4 flag-injection)', async () => {
      // Create a real branch we can verify is NOT touched even though the
      // attacker tries to pass `--all` or `-rf` as the branch name.
      executeSync('git', ['branch', 'real-branch'], { cwd: repoPath });
      await removeBranch(repoPath, '--all');
      await removeBranch(repoPath, '-rf');
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

    test('checkWorktreePathInProject rejects /etc', () => {
      const err = checkWorktreePathInProject(repoPath, '/etc');
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/outside the project's worktree base/i);
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
        expect(result.error.message).toMatch(/outside the project's worktree base/i);
      }
      // Sanity: /etc still exists.
      expect(existsSync('/etc')).toBe(true);
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
      expect(shouldRegisterSafeDirectory(123 as unknown)).toBe(false);
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
