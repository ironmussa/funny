/**
 * Materialize a project's repository inside a sandbox runner (change
 * thread-sandboxes). The checkout lives at the project's canonical path, so the
 * thread's cwd resolution, worktree creation and path-scope authorization work
 * exactly as on any other runner. A fresh clone then runs the project's
 * `.funny.json` `postCreate` (funny's `bun install`), so the agent starts with
 * its dependencies installed; the runner template's Bun cache makes it fast.
 */

import { existsSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, normalize } from 'path';

import { executeShell, gitWrite } from '@funny/core/git';
import { readProjectConfig } from '@funny/core/ports';
import { badRequest, conflict, processError, type DomainError } from '@funny/shared/errors';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';
import { redactGithubToken, withGithubToken } from '../utils/github-clone-url.js';

/** Generous: a first `bun install` may build native modules. */
const POST_CREATE_TIMEOUT_MS = 5 * 60_000;

const REPO_URL = /^(https:\/\/[^\s@]+|git@[^\s:]+:[^\s]+)$/;

export interface SandboxCheckoutInput {
  /** Must be the project's canonical path (checked by the route). */
  path: string;
  repoUrl: string;
  /** Per-operation GitHub token for private repositories, or null. */
  token: string | null;
}

/** Clone once; an existing checkout is reused as-is (idempotent). */
export function checkoutProjectIntoSandbox(
  input: SandboxCheckoutInput,
): ResultAsync<{ path: string; cloned: boolean }, DomainError> {
  const path = normalize(input.path);
  if (!isAbsolute(path) || input.path.includes('..')) {
    return errAsync(badRequest('Checkout path must be absolute'));
  }
  if (!REPO_URL.test(input.repoUrl)) return errAsync(badRequest('Invalid repository URL'));
  if (existsSync(join(path, '.git'))) return okAsync({ path, cloned: false });
  if (existsSync(path) && readdirSync(path).length > 0) {
    return errAsync(conflict(`${path} exists and is not a git checkout`));
  }

  const url = withGithubToken(input.repoUrl, input.token);
  const clone = ResultAsync.fromPromise(
    gitWrite(['clone', '--quiet', url, path], { cwd: dirname(path), reject: false }),
    (error) => processError(redactGithubToken(String(error)), 1),
  ).andThen((result) =>
    result.exitCode === 0
      ? okAsync(undefined)
      : errAsync(
          processError(
            `Clone failed: ${redactGithubToken(result.stderr)}`,
            result.exitCode,
            redactGithubToken(result.stderr),
          ),
        ),
  );

  return clone
    .andThen(() =>
      // Never leave the token in .git/config for later processes and agents.
      url === input.repoUrl
        ? okAsync(undefined)
        : ResultAsync.fromPromise(
            gitWrite(['-C', path, 'remote', 'set-url', 'origin', input.repoUrl], {
              reject: false,
            }),
            (error) => processError(redactGithubToken(String(error)), 1),
          ).map(() => undefined),
    )
    .andThen(() => ResultAsync.fromSafePromise(runSandboxPostCreate(path)))
    .map(() => ({ path, cloned: true }));
}

/**
 * Run the checkout's `postCreate` commands in order. Best effort, like worktree
 * setup: a failed command is logged and returned, never fails the checkout.
 */
export async function runSandboxPostCreate(path: string): Promise<string[]> {
  const errors: string[] = [];
  for (const cmd of readProjectConfig(path)?.postCreate ?? []) {
    try {
      await executeShell(cmd, { cwd: path, timeout: POST_CREATE_TIMEOUT_MS });
    } catch (error) {
      errors.push(`"${cmd}": ${String(error)}`);
      log.warn('Sandbox postCreate command failed', {
        namespace: 'thread-sandboxes',
        cmd,
        error: String(error),
      });
    }
  }
  return errors;
}
