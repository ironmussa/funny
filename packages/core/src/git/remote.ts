/**
 * Remote operations: push, pull, create PR, merge, clone.
 */

import { processError, badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git, gitRemote, type GitIdentityOptions } from './base.js';
import { getCurrentBranch } from './branch.js';
import { toDomainError } from './errors.js';
import { gitWrite, execute, ProcessExecutionError } from './process.js';

/**
 * Push to remote.
 * When identity.githubToken is provided, configures GIT_ASKPASS so that
 * `git push` can authenticate over HTTPS without interactive prompts.
 */
export function push(cwd: string, identity?: GitIdentityOptions): ResultAsync<string, DomainError> {
  return getCurrentBranch(cwd).andThen((branch) =>
    gitRemote(['push', '-u', 'origin', branch], cwd, identity),
  );
}

/**
 * Strategy used when `git pull` encounters diverging branches.
 * - `ff-only` → require fast-forward; fail if histories diverged (default, safest)
 * - `merge`   → create a merge commit (`git pull --no-ff`)
 * - `rebase`  → rebase local commits onto upstream (`git pull --rebase`)
 */
export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

/**
 * Pull from remote using the given strategy.
 * When `strategy` is omitted it defaults to `ff-only`.
 */
export function pull(
  cwd: string,
  strategy: PullStrategy = 'ff-only',
  identity?: GitIdentityOptions,
): ResultAsync<string, DomainError> {
  const args =
    strategy === 'rebase'
      ? ['pull', '--rebase']
      : strategy === 'merge'
        ? ['pull', '--no-ff']
        : ['pull', '--ff-only'];
  return gitRemote(args, cwd, identity);
}

/**
 * Create a pull request using GitHub CLI.
 * When identity.githubToken is provided, passes GH_TOKEN env var for authentication.
 */
export function createPR(
  cwd: string,
  title: string,
  body: string,
  baseBranch?: string,
  identity?: GitIdentityOptions,
): ResultAsync<string, DomainError> {
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (baseBranch) {
    args.push('--base', baseBranch);
  }
  const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  return ResultAsync.fromPromise(
    execute('gh', args, { cwd, timeout: 30_000, env }).then((r) => r.stdout.trim()),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Merge a feature branch into a target branch.
 * Must be run from the main repo directory (not a worktree).
 *
 * When worktreePath is provided, the feature branch is rebased onto
 * the target branch first (inside the worktree) so that the merge
 * into the target is always clean. If the rebase hits conflicts it
 * is aborted and the error is returned without touching the target.
 */
export function mergeBranch(
  cwd: string,
  featureBranch: string,
  targetBranch: string,
  identity?: GitIdentityOptions,
  worktreePath?: string,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // ── 1. Rebase feature branch onto target (inside worktree) ──
      if (worktreePath) {
        const rebaseResult = await git(['rebase', targetBranch], worktreePath);
        if (rebaseResult.isErr()) {
          await gitWrite(['rebase', '--abort'], { cwd: worktreePath, reject: false });
          throw badRequest(
            `Rebase failed — there are conflicts between your branch and ${targetBranch}. ` +
              `Resolve them in the worktree and try again.`,
          );
        }
      }

      // ── 2. Validate main working tree is clean ──
      const statusResult = await git(['status', '--porcelain'], cwd);
      if (statusResult.isErr()) throw statusResult.error;
      if (statusResult.value.trim()) {
        throw badRequest(
          'Cannot merge: the main working tree has uncommitted changes. Please commit or stash changes first.',
        );
      }

      const branchResult = await getCurrentBranch(cwd);
      if (branchResult.isErr()) throw branchResult.error;
      const originalBranch = branchResult.value;

      // ── 3. Merge into target ──
      try {
        const checkoutResult = await git(['checkout', targetBranch], cwd);
        if (checkoutResult.isErr()) throw checkoutResult.error;

        // Sanitize branch names in commit message to prevent injection via crafted branch names
        const safeFB = featureBranch.replace(/['\n\r\\]/g, '');
        const safeTB = targetBranch.replace(/['\n\r\\]/g, '');
        const mergeArgs = [
          'merge',
          '--no-ff',
          featureBranch,
          '-m',
          `Merge branch '${safeFB}' into ${safeTB}`,
        ];
        if (identity?.author) {
          mergeArgs.push('--author', `${identity.author.name} <${identity.author.email}>`);
        }
        const mergeResult = await git(mergeArgs, cwd);
        if (mergeResult.isErr()) throw mergeResult.error;
        return mergeResult.value;
      } catch (error) {
        await gitWrite(['merge', '--abort'], { cwd, reject: false });
        await gitWrite(['checkout', originalBranch], { cwd, reject: false });
        throw error;
      }
    })(),
    toDomainError,
  );
}

/**
 * Clone a remote repository.
 *
 * Credentials are the caller's responsibility — pass a pre-authenticated URL
 * or inject env vars (e.g. `GIT_ASKPASS`) through `options.env`.
 */
export function cloneRepo(
  repoUrl: string,
  destination: string,
  options?: { branch?: string; depth?: number; env?: Record<string, string> },
): ResultAsync<string, DomainError> {
  const args = ['clone'];
  if (options?.branch) args.push('--branch', options.branch);
  if (options?.depth) args.push('--depth', String(options.depth));
  args.push('--', repoUrl, destination);

  return ResultAsync.fromPromise(
    execute('git', args, { env: options?.env, skipPool: true }),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  ).map((result) => result.stdout.trim());
}
