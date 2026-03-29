import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { resolve, dirname, basename, normalize } from 'path';

import type { SetupProgressFn } from '@funny/core/ports';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git } from './git.js';
import { gitRead, gitWrite } from './process.js';

export const WORKTREE_DIR_NAME = '.funny-worktrees';

export async function getWorktreeBase(projectPath: string): Promise<string> {
  const projectName = basename(projectPath);
  const base = resolve(dirname(projectPath), WORKTREE_DIR_NAME, projectName);
  await mkdir(base, { recursive: true });
  return base;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

export function createWorktree(
  projectPath: string,
  branchName: string,
  baseBranch?: string,
  onProgress?: SetupProgressFn,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
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

      const base = await getWorktreeBase(projectPath);
      // Sanitize branch name: allow only safe characters, strip path traversal attempts
      const safeBranchDir = branchName
        .replace(/\.\./g, '') // Remove path traversal
        .replace(/[^a-zA-Z0-9._\-/]/g, '-') // Keep only safe chars
        .replace(/\//g, '-'); // Replace slashes with hyphens
      const worktreePath = resolve(base, safeBranchDir);

      if (existsSync(worktreePath)) {
        throw badRequest(`Worktree already exists: ${worktreePath}`);
      }

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
  return git(['worktree', 'list', '--porcelain'], projectPath).map((output) => {
    const entries: WorktreeInfo[] = [];
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
    return entries.map((w) => ({
      ...w,
      isMain: normalize(w.path) === normalizedProject,
    }));
  });
}

export async function removeWorktree(projectPath: string, worktreePath: string): Promise<void> {
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
    throw new Error(
      `Failed to remove worktree directory: ${worktreePath} — ${result.stderr.trim()}`,
    );
  }
}

export async function removeBranch(projectPath: string, branchName: string): Promise<void> {
  await gitWrite(['branch', '-D', branchName], { cwd: projectPath, reject: false });
}
