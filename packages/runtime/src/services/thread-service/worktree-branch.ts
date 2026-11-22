/**
 * @domain subdomain: Thread Management
 * @domain type: domain-service
 * @domain layer: application
 *
 * The branch a new `worktree` thread's worktree is created on.
 */

import { findWorktreeForBranch, git } from '@funny/core/git';

export interface WorktreeBranch {
  name: string;
  /** The branch exists already: check it out instead of creating it. */
  reuse: boolean;
}

/**
 * The caller's `requested` branch, else `generated`:
 *
 * - `requested` does not exist yet: it is created.
 * - It exists and no worktree has it checked out: it is reused, so a retried
 *   issue-factory run goes on from its earlier attempt on the same branch
 *   (and the same pull request) instead of leaving a second branch.
 * - It is checked out in another worktree (the earlier attempt's thread is
 *   still there): git cannot check it out twice, so `generated` is used and
 *   the thread still starts; the agent is told the branch to push.
 */
export async function worktreeBranchName(
  projectPath: string,
  requested: string | undefined,
  generated: string,
): Promise<WorktreeBranch> {
  const fallback = { name: generated, reuse: false };
  const name = requested?.trim();
  if (!name) return fallback;
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], projectPath);
  if (exists.isErr()) return { name, reuse: false };
  const checkedOut = await findWorktreeForBranch(projectPath, name);
  return checkedOut.isOk() && checkedOut.value === null ? { name, reuse: true } : fallback;
}
