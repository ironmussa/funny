/**
 * Handles git operations locally on behalf of the central server.
 * Wraps @funny/core/git functions and returns structured results.
 */

import {
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  stageFiles,
  unstageFiles,
  revertFiles,
  commit,
  push,
  pull,
  createPR,
  mergeBranch,
  listBranches,
  getCurrentBranch,
  getDefaultBranch,
  getLog,
  getStatusSummary,
  stash,
  stashPop,
  stashList,
  resetSoft,
  type GitIdentityOptions,
} from '@funny/core/git';
import { createWorktree, listWorktrees, removeWorktree } from '@funny/core/git';
import type { GitOperationType, RunnerGitResponse } from '@funny/shared/runner-protocol';

export async function handleGitOperation(
  operation: GitOperationType,
  cwd: string,
  params: Record<string, unknown>,
): Promise<RunnerGitResponse> {
  try {
    const data = await executeGitOp(operation, cwd, params);
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function executeGitOp(
  operation: GitOperationType,
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const identity = params.identity as GitIdentityOptions | undefined;

  switch (operation) {
    case 'diff': {
      const result = await getDiff(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'diff_summary': {
      const result = await getDiffSummary(cwd, {
        excludePatterns: params.excludePatterns as string[] | undefined,
        maxFiles: params.maxFiles as number | undefined,
      });
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'single_file_diff': {
      const result = await getSingleFileDiff(
        cwd,
        params.filePath as string,
        params.staged as boolean,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'stage': {
      const result = await stageFiles(cwd, params.paths as string[]);
      if (result.isErr()) throw new Error(result.error.message);
      return null;
    }

    case 'unstage': {
      const result = await unstageFiles(cwd, params.paths as string[]);
      if (result.isErr()) throw new Error(result.error.message);
      return null;
    }

    case 'revert': {
      const result = await revertFiles(cwd, params.paths as string[]);
      if (result.isErr()) throw new Error(result.error.message);
      return null;
    }

    case 'commit': {
      const result = await commit(
        cwd,
        params.message as string,
        identity,
        params.amend as boolean | undefined,
        params.noVerify as boolean | undefined,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'push': {
      const result = await push(cwd, identity);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'create_pr': {
      const result = await createPR(
        cwd,
        params.title as string,
        params.body as string,
        params.baseBranch as string | undefined,
        identity,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'merge': {
      const result = await mergeBranch(
        cwd,
        params.featureBranch as string,
        params.targetBranch as string,
        identity,
        params.worktreePath as string | undefined,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'branches': {
      const result = await listBranches(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'current_branch': {
      const result = await getCurrentBranch(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'default_branch': {
      const result = await getDefaultBranch(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'log': {
      const result = await getLog(
        cwd,
        params.limit as number | undefined,
        params.baseBranch as string | null | undefined,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'status_summary': {
      const result = await getStatusSummary(
        cwd,
        params.baseBranch as string | undefined,
        params.projectCwd as string | undefined,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'pull': {
      const result = await pull(cwd, identity);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'stash': {
      const result = await stash(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'stash_pop': {
      const result = await stashPop(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'stash_list': {
      const result = await stashList(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'reset_soft': {
      const result = await resetSoft(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'create_worktree': {
      const result = await createWorktree(
        cwd,
        params.branchName as string,
        params.baseBranch as string | undefined,
      );
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'list_worktrees': {
      const result = await listWorktrees(cwd);
      if (result.isErr()) throw new Error(result.error.message);
      return result.value;
    }

    case 'remove_worktree': {
      await removeWorktree(cwd, params.worktreePath as string);
      return null;
    }

    default:
      throw new Error(`Unknown git operation: ${operation}`);
  }
}
