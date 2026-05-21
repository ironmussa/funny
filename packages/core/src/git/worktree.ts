import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, stat } from 'fs/promises';
import { resolve, dirname, basename, normalize, join } from 'path';

import type { SetupProgressFn } from '@funny/core/ports';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git } from './base.js';
import { gitRead, gitWrite } from './process.js';

/**
 * Ensure a directory is registered as a git safe.directory so that
 * git doesn't reject operations when the directory owner differs from
 * the current user (common when the repo was created by a web server
 * or another process).
 *
 * Uses `git config --global --get-all` to check first and only adds
 * if not already present, so it's idempotent and safe to call repeatedly.
 */
async function ensureSafeDirectory(dirPath: string): Promise<void> {
  // Check if already registered
  const check = await gitRead(['config', '--global', '--get-all', 'safe.directory'], {
    reject: false,
  });
  if (check.exitCode === 0) {
    const existing = check.stdout.split('\n').map((l) => l.trim());
    if (existing.includes(dirPath)) return;
  }
  // Add to global config
  await gitWrite(['config', '--global', '--add', 'safe.directory', dirPath], { reject: false });
}

export const WORKTREE_DIR_NAME = '.funny-worktrees';

/** Compute the worktree base path without creating the directory. */
export function getWorktreeBasePath(projectPath: string): string {
  const projectName = basename(projectPath);
  return resolve(dirname(projectPath), WORKTREE_DIR_NAME, projectName);
}

export function getWorktreeBase(projectPath: string): ResultAsync<string, DomainError> {
  const base = getWorktreeBasePath(projectPath);
  return ResultAsync.fromPromise(
    mkdir(base, { recursive: true }).then(() => base),
    (error) => internal(String(error)),
  );
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  lastActivityMs?: number;
}

export interface WorktreePreview {
  sanitizedBranchDir: string;
  branchName: string;
  worktreePath: string;
  alreadyExists: boolean;
}

export function createWorktree(
  projectPath: string,
  branchName: string,
  baseBranch?: string,
  onProgress?: SetupProgressFn,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Ensure project path is a git safe.directory so commands don't fail
      // when the repo owner differs from the current user (e.g. www-data vs argenisleon).
      await ensureSafeDirectory(projectPath);

      // Ensure the repo has at least one commit — git worktree requires it.
      onProgress?.('worktree:init', 'Checking repository', 'running');
      const headResult = await gitRead(['rev-parse', 'HEAD'], {
        cwd: projectPath,
        reject: false,
      });
      if (headResult.exitCode !== 0) {
        const commitResult = await gitWrite(['commit', '--allow-empty', '-m', 'Initial commit'], {
          cwd: projectPath,
          reject: false,
        });
        if (commitResult.exitCode !== 0) {
          onProgress?.('worktree:init', 'Checking repository', 'failed');
          throw badRequest(
            `Cannot create worktree: the repository has no commits and the auto-commit failed: ${commitResult.stderr}`,
          );
        }
      }
      onProgress?.('worktree:init', 'Checking repository', 'completed');

      // Resolve the base branch ref. Try the name as-is first, then try
      // origin/<name> for remote-only branches (common after a fresh clone).
      let effectiveBase = baseBranch;
      if (baseBranch) {
        onProgress?.('worktree:resolve', `Resolving branch "${baseBranch}"`, 'running');
        const branchCheck = await gitRead(['rev-parse', '--verify', baseBranch], {
          cwd: projectPath,
          reject: false,
        });
        if (branchCheck.exitCode !== 0) {
          // Branch doesn't exist locally — try origin/<name>
          const remoteRef = `origin/${baseBranch}`;
          const remoteCheck = await gitRead(['rev-parse', '--verify', remoteRef], {
            cwd: projectPath,
            reject: false,
          });
          if (remoteCheck.exitCode === 0) {
            effectiveBase = remoteRef;
            onProgress?.(
              'worktree:resolve',
              `Using remote branch "origin/${baseBranch}"`,
              'completed',
            );
          } else {
            effectiveBase = undefined;
            onProgress?.(
              'worktree:resolve',
              `Branch "${baseBranch}" not found, using HEAD`,
              'completed',
            );
          }
        } else {
          onProgress?.('worktree:resolve', `Resolved branch "${baseBranch}"`, 'completed');
        }
      }

      const baseResult = await getWorktreeBase(projectPath);
      if (baseResult.isErr()) throw baseResult.error;
      const base = baseResult.value;
      // Sanitize branch name: strict whitelist, reject traversal attempts entirely
      if (/\.\./.test(branchName)) {
        throw badRequest('Branch name must not contain path traversal sequences (..)');
      }
      // Security L4: reject branch names that start with `-`. Git treats
      // leading-dash arguments as flags, so a value like `-rf` or `--exec=cmd`
      // could turn `git branch <name>` / `git worktree add -b <name>` into a
      // command-injection vector. The downstream `safeBranchDir` filter
      // doesn't help here because the *raw* `branchName` is what reaches git.
      if (branchName.startsWith('-')) {
        throw badRequest('Branch name must not start with "-"');
      }
      const safeBranchDir = branchName.replace(/[^a-zA-Z0-9._-]/g, '-'); // Keep only safe chars (no slashes)
      if (!safeBranchDir || safeBranchDir === '.' || safeBranchDir === '..') {
        throw badRequest('Invalid branch name after sanitization');
      }
      const worktreePath = resolve(base, safeBranchDir);

      if (existsSync(worktreePath)) {
        throw badRequest(`Worktree already exists: ${worktreePath}`);
      }

      // Pre-register the worktree path as safe so subsequent git commands
      // inside the worktree don't fail due to ownership mismatch.
      await ensureSafeDirectory(worktreePath);

      onProgress?.(
        'worktree:create',
        `Creating worktree from ${effectiveBase ?? 'HEAD'}`,
        'running',
      );
      const args = ['worktree', 'add', '-b', branchName, worktreePath];
      if (effectiveBase) args.push(effectiveBase);
      const result = await git(args, projectPath);
      if (result.isErr()) {
        onProgress?.(
          'worktree:create',
          `Creating worktree from ${effectiveBase ?? 'HEAD'}`,
          'failed',
        );
        throw result.error;
      }
      onProgress?.(
        'worktree:create',
        `Creating worktree from ${effectiveBase ?? 'HEAD'}`,
        'completed',
      );
      return worktreePath;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

export function listWorktrees(projectPath: string): ResultAsync<WorktreeInfo[], DomainError> {
  return git(['worktree', 'list', '--porcelain'], projectPath).andThen((output) => {
    const entries: Array<Omit<WorktreeInfo, 'isMain' | 'lastActivityMs'>> = [];
    let current: Partial<WorktreeInfo> = {};

    for (const raw of output.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current as WorktreeInfo);
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch refs/heads/'.length);
      }
    }

    if (current.path) entries.push(current as WorktreeInfo);

    const normalizedProject = normalize(projectPath);

    return ResultAsync.fromPromise(
      Promise.all(
        entries.map(async (w) => ({
          ...w,
          isMain: normalize(w.path) === normalizedProject,
          lastActivityMs: (await getLastGitActivity(w.path)) ?? undefined,
        })),
      ),
      (error) => internal(String(error)),
    );
  });
}

export function removeWorktree(
  projectPath: string,
  worktreePath: string,
): ResultAsync<void, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitWrite(['worktree', 'remove', '-f', worktreePath], {
        cwd: projectPath,
        reject: false,
      });

      // If git worktree remove succeeded or the directory is already gone, we're done.
      if (result.exitCode === 0 || !existsSync(worktreePath)) return;

      // Fallback: on Windows, file locks (antivirus, IDE, stale processes) commonly
      // prevent `git worktree remove`. Force-delete the directory, then prune the
      // worktree bookkeeping so git stays consistent.
      await rm(worktreePath, { recursive: true, force: true });
      await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });

      if (existsSync(worktreePath)) {
        throw internal(
          `Failed to remove worktree directory: ${worktreePath} — ${result.stderr.trim()}`,
        );
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

export function removeBranch(
  projectPath: string,
  branchName: string,
): ResultAsync<void, DomainError> {
  // Security L4: never pass a value starting with `-` directly to git as an
  // argument — it would be interpreted as a flag (potentially something like
  // `--exec=...`). The branch arg position here is positional but git's CLI
  // does not have a unanimous `--` separator across all commands; the safer
  // course is to reject the name outright. Caller is responsible for
  // surfacing this — `removeBranch` is best-effort cleanup that should never
  // execute on a hostile-looking name.
  if (branchName.startsWith('-')) {
    return ResultAsync.fromSafePromise(Promise.resolve());
  }
  return ResultAsync.fromPromise(
    gitWrite(['branch', '-D', '--', branchName], { cwd: projectPath, reject: false }).then(
      () => undefined,
    ),
    (error) => internal(String(error)),
  );
}

/**
 * Resolve the actual git directory for a worktree path.
 * For linked worktrees, `.git` is a file containing `gitdir: <path>`.
 * For the main worktree, `.git` is the directory itself.
 */
function resolveGitDir(worktreePath: string): string {
  const gitPath = join(worktreePath, '.git');
  try {
    const content = readFileSync(gitPath, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)/);
    if (match) return resolve(worktreePath, match[1].trim());
  } catch {
    // Not a file — likely the main worktree where .git is a directory
  }
  return gitPath;
}

/**
 * Get the last git activity timestamp for a worktree by checking
 * modification times of key git bookkeeping files.
 * Returns Unix milliseconds or null if no files could be stat'd.
 */
export async function getLastGitActivity(worktreePath: string): Promise<number | null> {
  const gitDir = resolveGitDir(worktreePath);
  const filesToCheck = [join(gitDir, 'index'), join(gitDir, 'HEAD'), join(gitDir, 'logs', 'HEAD')];

  let latestMs = 0;
  for (const file of filesToCheck) {
    try {
      const st = await stat(file);
      if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
    } catch {
      // File may not exist
    }
  }
  return latestMs > 0 ? latestMs : null;
}

/**
 * Preview a worktree creation without actually creating it.
 * Returns the sanitized directory name, branch name, path, and whether it already exists.
 */
/**
 * Prune orphan worktrees for a given project path.
 * Runs `git worktree prune` to clean up stale bookkeeping entries,
 * then removes any leftover directories under the worktree base that
 * are no longer registered with git.
 */
export function pruneOrphanWorktrees(projectPath: string): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Run git worktree prune to clean stale entries
      await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });

      const base = getWorktreeBasePath(projectPath);
      if (!existsSync(base)) return 0;

      // List registered worktrees
      const listResult = await gitRead(['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
        reject: false,
      });
      const registeredPaths = new Set<string>();
      if (listResult.exitCode === 0) {
        for (const line of listResult.stdout.split('\n')) {
          if (line.startsWith('worktree ')) {
            registeredPaths.add(normalize(line.slice('worktree '.length)));
          }
        }
      }

      // Check for orphan directories under the worktree base
      let pruned = 0;
      try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(base, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = normalize(resolve(base, entry.name));
          if (!registeredPaths.has(dirPath)) {
            try {
              await rm(dirPath, { recursive: true, force: true });
              pruned++;
            } catch {
              // Best-effort cleanup
            }
          }
        }
      } catch {
        // Base directory unreadable — nothing to prune
      }

      return pruned;
    })(),
    (error) => internal(String(error)),
  );
}

export function previewWorktree(
  projectPath: string,
  branchName: string,
): ResultAsync<WorktreePreview, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Security L4: leading `-` would be a CLI flag once the caller acts on
      // the preview (e.g. via `worktree add -b <name>`). Reject up front so
      // the UI gets a clear error instead of executing a flag injection.
      if (branchName.startsWith('-')) {
        throw badRequest('Branch name must not start with "-"');
      }
      const base = getWorktreeBasePath(projectPath);
      const safeBranchDir = branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
      const worktreePath = resolve(base, safeBranchDir);
      return {
        sanitizedBranchDir: safeBranchDir,
        branchName,
        worktreePath,
        alreadyExists: existsSync(worktreePath),
      };
    })(),
    (error) => internal(String(error)),
  );
}
