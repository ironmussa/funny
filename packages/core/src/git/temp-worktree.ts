/**
 * Temporary detached worktrees for the regression proof gate.
 *
 * A temporary worktree is created at a commit (detached HEAD), lives under the
 * project's worktree base with a fixed name prefix, and is removed in `finally`.
 * No branch is created or deleted.
 */

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { errAsync, ResultAsync } from 'neverthrow';

import { toDomainError } from './errors.js';
import { gitRead, gitWrite } from './process.js';
import { isSafeGitRefArg } from './ref-guard.js';
import { getWorktreeBasePath } from './worktree.js';

export const TEMP_WORKTREE_PREFIX = 'proof-tmp-';

/**
 * Create a detached temporary worktree at `commitSha` under the project's
 * worktree base. The worktree has no branch (detached HEAD). Returns the
 * absolute path of the new worktree directory.
 */
export function createTempWorktree(
  projectPath: string,
  commitSha: string,
  suffix = '',
): ResultAsync<string, DomainError> {
  if (!isSafeGitRefArg(commitSha)) {
    return errAsync(badRequest(`Invalid commit ref: ${commitSha}`));
  }

  return ResultAsync.fromPromise(
    (async () => {
      const base = getWorktreeBasePath(projectPath);
      const name = `${TEMP_WORKTREE_PREFIX}${Date.now()}${suffix ? `-${suffix}` : ''}`;
      const worktreePath = resolve(base, name);

      if (existsSync(worktreePath)) {
        throw internal(`Temporary worktree path already exists: ${worktreePath}`);
      }

      const result = await gitWrite(['worktree', 'add', '--detach', worktreePath, commitSha], {
        cwd: projectPath,
        timeout: 0,
      });
      if (result.exitCode !== 0) {
        throw internal(`Failed to create temp worktree: ${result.stderr}`);
      }
      return worktreePath;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

/**
 * Remove a temporary worktree by path. Only removes worktrees whose directory
 * name starts with the temp prefix, as a safety check. Best effort: errors
 * during removal are logged but not thrown.
 */
export function removeTempWorktree(
  projectPath: string,
  worktreePath: string,
): ResultAsync<void, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const dirName = basename(worktreePath);
      if (!dirName.startsWith(TEMP_WORKTREE_PREFIX)) {
        throw badRequest(
          `Refusing to remove worktree that is not a temp proof worktree: ${dirName}`,
        );
      }

      const base = getWorktreeBasePath(projectPath);
      const expected = resolve(base, dirName);
      if (resolve(worktreePath) !== expected) {
        throw badRequest('Temp worktree path is outside the project worktree base');
      }

      await gitWrite(['worktree', 'remove', '-f', worktreePath], {
        cwd: projectPath,
        reject: false,
      });

      if (existsSync(worktreePath)) {
        await rm(worktreePath, { recursive: true, force: true });
      }

      await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

/**
 * Copy files from `fromCommit` into `worktreePath` using `git checkout`.
 * Paths are relative to the repository root. Refuses paths that start with
 * `-` or contain `..`.
 */
export function copyFilesFromCommit(
  projectPath: string,
  worktreePath: string,
  fromCommit: string,
  files: string[],
): ResultAsync<void, DomainError> {
  if (!isSafeGitRefArg(fromCommit)) {
    return errAsync(badRequest(`Invalid commit ref: ${fromCommit}`));
  }

  for (const file of files) {
    if (file.startsWith('-') || file.includes('..')) {
      return errAsync(badRequest(`Invalid file path: ${file}`));
    }
  }

  if (files.length === 0) {
    return ResultAsync.fromSafePromise(Promise.resolve());
  }

  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitWrite(['checkout', fromCommit, '--', ...files], {
        cwd: worktreePath,
        timeout: 0,
      });
      if (result.exitCode !== 0) {
        throw internal(`Failed to copy files from ${fromCommit}: ${result.stderr}`);
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

/**
 * List files changed between `base` and `head` (added or modified only).
 * Returns paths relative to the repository root.
 */
export function changedFilesBetween(
  projectPath: string,
  base: string,
  head: string,
): ResultAsync<string[], DomainError> {
  if (!isSafeGitRefArg(base)) {
    return errAsync(badRequest(`Invalid base ref: ${base}`));
  }
  if (!isSafeGitRefArg(head)) {
    return errAsync(badRequest(`Invalid head ref: ${head}`));
  }

  return ResultAsync.fromPromise(
    gitRead(['diff', '--name-only', '--diff-filter=AM', base, head], {
      cwd: projectPath,
    }),
    toDomainError,
  ).map((result) =>
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Compute the merge-base of two refs. Returns the merge-base commit SHA.
 */
export function mergeBase(
  projectPath: string,
  ref1: string,
  ref2: string,
): ResultAsync<string, DomainError> {
  if (!isSafeGitRefArg(ref1)) {
    return errAsync(badRequest(`Invalid ref: ${ref1}`));
  }
  if (!isSafeGitRefArg(ref2)) {
    return errAsync(badRequest(`Invalid ref: ${ref2}`));
  }

  return ResultAsync.fromPromise(
    gitRead(['merge-base', ref1, ref2], { cwd: projectPath }),
    toDomainError,
  ).map((result) => result.stdout.trim());
}

/**
 * Sweep leftover temporary proof worktrees (by prefix) under every worktree
 * base of the project. Returns the number of directories removed.
 */
export function sweepTempWorktrees(projectPath: string): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const base = getWorktreeBasePath(projectPath);
      if (!existsSync(base)) return 0;

      let swept = 0;
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(TEMP_WORKTREE_PREFIX)) {
          const fullPath = join(base, entry.name);
          await gitWrite(['worktree', 'remove', '-f', fullPath], {
            cwd: projectPath,
            reject: false,
          });
          if (existsSync(fullPath)) {
            await rm(fullPath, { recursive: true, force: true });
          }
          swept++;
        }
      }

      if (swept > 0) {
        await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });
      }
      return swept;
    })(),
    (error) => internal(String(error)),
  );
}
