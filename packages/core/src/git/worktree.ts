import { resolve, dirname, basename, normalize } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { ok, err, ResultAsync } from 'neverthrow';
import { git } from './git.js';
import { execute } from './process.js';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';

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
  baseBranch?: string
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Verify the repo has at least one commit
      const headResult = await execute('git', ['rev-parse', 'HEAD'], { cwd: projectPath, reject: false });
      if (headResult.exitCode !== 0) {
        throw badRequest(
          'Cannot create worktree: the repository has no commits yet. Please make an initial commit first.'
        );
      }

      const base = await getWorktreeBase(projectPath);
      const worktreePath = resolve(base, branchName.replace(/\//g, '-'));

      if (existsSync(worktreePath)) {
        throw badRequest(`Worktree already exists: ${worktreePath}`);
      }

      const args = ['worktree', 'add', '-b', branchName, worktreePath];
      if (baseBranch) args.push(baseBranch);
      const result = await git(args, projectPath);
      if (result.isErr()) throw result.error;
      return worktreePath;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    }
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
  await execute('git', ['worktree', 'remove', '-f', worktreePath], { cwd: projectPath, reject: false });
}

export async function removeBranch(projectPath: string, branchName: string): Promise<void> {
  await execute('git', ['branch', '-D', branchName], { cwd: projectPath, reject: false });
}
