/**
 * Base git helpers used across all git modules.
 *
 * - git()        — safe write wrapper returning ResultAsync
 * - gitOptional() — read wrapper returning null on failure
 * - gitSync() / gitSafeSync() — sync variants for startup checks
 * - isGitRepo()  — async/sync repo detection
 * - gitRemote()  — authenticated remote commands (push, pull, fetch)
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import type { DomainError } from '@funny/shared/errors';
import { processError, internal } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { toDomainError } from './errors.js';
import { validatePath, validatePathSync } from './path-validation.js';
import { gitRead, gitWrite, executeSync, ProcessExecutionError } from './process.js';

/** Per-user git identity for multi-user mode. */
export interface GitIdentityOptions {
  author?: { name: string; email: string };
  githubToken?: string;
}

/**
 * Execute a git command safely with proper argument escaping.
 * Returns ResultAsync<string, DomainError>.
 */
export function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): ResultAsync<string, DomainError> {
  return validatePath(cwd).andThen((validCwd) =>
    ResultAsync.fromPromise(gitWrite(args, { cwd: validCwd, env }), toDomainError).map((result) =>
      result.stdout.trim(),
    ),
  );
}

/**
 * Internal helper: git command that returns null on failure instead of Err.
 * Used for non-critical operations (branch listing, status checks, etc.).
 */
export function gitOptional(args: string[], cwd: string): Promise<string | null> {
  return gitRead(args, { cwd, reject: false })
    .then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null))
    .catch(() => null);
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await gitOptional(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

/**
 * Execute a git command synchronously (use only when necessary, e.g. startup validation)
 */
export function gitSync(args: string[], cwd: string): string {
  validatePathSync(cwd);
  const { stdout } = executeSync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Execute a git command synchronously that may fail without throwing
 */
export function gitSafeSync(args: string[], cwd: string): string | null {
  try {
    return gitSync(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Check if a path is a git repository (synchronous version)
 */
export function isGitRepoSync(path: string): boolean {
  const result = gitSafeSync(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

function canonicalize(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Check if `path` is the ROOT of its git repository (not a nested directory
 * inside one). Git's rev-parse walks up the directory tree to find a `.git`,
 * which means a non-repo directory sitting inside another repo would still
 * pass `isGitRepoSync`. This stricter check compares `show-toplevel` against
 * the given path so callers can reject nested or parent-owned directories.
 */
export function isGitRepoRootSync(path: string): boolean {
  const toplevel = gitSafeSync(['rev-parse', '--show-toplevel'], path);
  if (!toplevel) return false;
  return canonicalize(toplevel) === canonicalize(path);
}

/** Async variant of {@link isGitRepoRootSync}. */
export async function isGitRepoRoot(path: string): Promise<boolean> {
  const toplevel = await gitOptional(['rev-parse', '--show-toplevel'], path);
  if (!toplevel) return false;
  return canonicalize(toplevel) === canonicalize(path);
}

/**
 * Run a git command that requires remote access (push, pull, fetch).
 * Sets up GIT_ASKPASS for HTTPS token auth and GIT_TERMINAL_PROMPT=0
 * so git fails fast instead of hanging when no credentials are available.
 */
export function gitRemote(
  args: string[],
  cwd: string,
  identity?: GitIdentityOptions,
  timeout = 120_000,
): ResultAsync<string, DomainError> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
  };

  let askpassPath: string | undefined;

  if (identity?.githubToken) {
    env.GH_TOKEN = identity.githubToken;

    // Create a temporary GIT_ASKPASS script that returns the token for
    // both Username and Password prompts. GitHub accepts the PAT as
    // either the username (with any/empty password) or via the
    // x-access-token convention. By always echoing the token we cover
    // the "Username for ..." prompt that git issues first.
    // Create askpass script in a private temporary directory atomically
    const askpassDir = mkdtempSync(join(tmpdir(), 'funny-askpass-'));
    askpassPath = join(askpassDir, 'askpass.sh');
    const safeToken = identity.githubToken.replace(/'/g, "'\\''");
    writeFileSync(askpassPath, `#!/bin/sh\necho '${safeToken}'\n`, { mode: 0o500 });
    env.GIT_ASKPASS = askpassPath;

    // Also set the Authorization header directly — this is the most
    // reliable method for GitHub HTTPS and avoids the Username/Password
    // prompt dance entirely.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${identity.githubToken}`).toString('base64')}`;
  }

  return ResultAsync.fromPromise(
    gitWrite(args, { cwd, env, timeout }).finally(() => {
      if (askpassPath) {
        try {
          // Remove the entire private askpass directory
          rmSync(dirname(askpassPath), { recursive: true, force: true });
        } catch {}
      }
    }),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  ).map((result) => result.stdout.trim());
}
