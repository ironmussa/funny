import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { resolve, dirname, basename, normalize } from 'path';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git } from './git.js';
import { execute } from './process.js';

const WORKTREE_DIR_NAME = '.funny-worktrees';

async function getWorktreeBase(projectPath: string): Promise<string> {
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
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Ensure the repo has at least one commit — git worktree requires it.
      // If the repo is brand new (no commits), create an empty initial commit
      // so worktree creation works transparently.
      const headResult = await execute('git', ['rev-parse', 'HEAD'], {
        cwd: projectPath,
        reject: false,
      });
      if (headResult.exitCode !== 0) {
        const commitResult = await execute(
          'git',
          ['commit', '--allow-empty', '-m', 'Initial commit'],
          { cwd: projectPath, reject: false },
        );
        if (commitResult.exitCode !== 0) {
          throw badRequest(
            `Cannot create worktree: the repository has no commits and the auto-commit failed: ${commitResult.stderr}`,
          );
        }
      }

      // Verify the requested baseBranch actually exists as a ref.
      // Common mismatch: agent detects "master" but the repo uses "main"
      // (or vice versa). Fall back to HEAD when the ref is invalid.
      let effectiveBase = baseBranch;
      if (baseBranch) {
        const branchCheck = await execute('git', ['rev-parse', '--verify', baseBranch], {
          cwd: projectPath,
          reject: false,
        });
        if (branchCheck.exitCode !== 0) {
          effectiveBase = undefined;
        }
      }

      const base = await getWorktreeBase(projectPath);
      const worktreePath = resolve(base, branchName.replace(/\//g, '-'));

      if (existsSync(worktreePath)) {
        throw badRequest(`Worktree already exists: ${worktreePath}`);
      }

      const args = ['worktree', 'add', '-b', branchName, worktreePath];
      if (effectiveBase) args.push(effectiveBase);
      const result = await git(args, projectPath);
      if (result.isErr()) throw result.error;
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
  await execute('git', ['worktree', 'remove', '-f', worktreePath], {
    cwd: projectPath,
    reject: false,
  });
}

export async function removeBranch(projectPath: string, branchName: string): Promise<void> {
  await execute('git', ['branch', '-D', branchName], { cwd: projectPath, reject: false });
}
