import { resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { gitSync, gitSafeSync } from '../utils/git-v2.js';

const WORKTREE_DIR_NAME = '.a-parallel-worktrees';

function getWorktreeBase(projectPath: string): string {
  const base = resolve(dirname(projectPath), WORKTREE_DIR_NAME);
  mkdirSync(base, { recursive: true });
  return base;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

export function createWorktree(
  projectPath: string,
  branchName: string,
  baseBranch = 'main'
): string {
  const base = getWorktreeBase(projectPath);
  const worktreePath = resolve(base, branchName.replace(/\//g, '-'));

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists: ${worktreePath}`);
  }

  gitSync(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], projectPath);
  return worktreePath;
}

export function listWorktrees(projectPath: string): WorktreeInfo[] {
  const output = gitSync(['worktree', 'list', '--porcelain'], projectPath);
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split('\n')) {
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

  // Filter to only our managed worktrees
  const base = getWorktreeBase(projectPath);
  return entries.filter((w) => w.path.startsWith(base));
}

export function removeWorktree(projectPath: string, worktreePath: string): void {
  gitSafeSync(['worktree', 'remove', '-f', worktreePath], projectPath);
}
