/**
 * @domain subdomain: Thread Management
 * @domain type: domain-service
 * @domain layer: application
 *
 * The branch a new `worktree` thread's worktree is created on.
 */

import { git } from '@funny/core/git';

/**
 * The caller's `requested` branch when it does not exist yet, else `generated`.
 *
 * `git worktree add -b` cannot create a branch that already exists, and an
 * existing one may be checked out in another worktree (a factory run retried
 * after its first thread failed). Falling back keeps the thread starting; the
 * agent is told the branch to push and can switch to it.
 */
export async function worktreeBranchName(
  projectPath: string,
  requested: string | undefined,
  generated: string,
): Promise<string> {
  const name = requested?.trim();
  if (!name) return generated;
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], projectPath);
  return exists.isOk() ? generated : name;
}
