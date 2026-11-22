/**
 * @domain subdomain: Thread Management
 * @domain type: domain-service
 * @domain layer: application
 *
 * The branch guard on a follow-up: a message that names the branch it expects
 * (the issue factory's run branch) runs only while the thread's worktree is on
 * it. A person or another agent may switch a worktree's branch; the next
 * factory step would then commit and push to the wrong one.
 */

import { getCurrentBranch } from '@funny/core/git';
import { conflict, type DomainError } from '@funny/shared/errors';
import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

/**
 * Ok when no branch is expected, the thread has no worktree (nothing of its
 * own to switch), or its worktree is on `expected`. A worktree whose branch
 * cannot be read (detached HEAD, missing directory) is refused too.
 */
export function checkExpectedBranch(
  worktreePath: string | null | undefined,
  expected: string | undefined,
): ResultAsync<void, DomainError> {
  if (!expected || !worktreePath) return okAsync(undefined);
  return getCurrentBranch(worktreePath)
    .orElse(() => okAsync(''))
    .andThen((current) =>
      current === expected
        ? okAsync(undefined)
        : errAsync(
            conflict(
              current
                ? `The thread's worktree is on branch "${current}", not "${expected}": switch it back to "${expected}" before continuing.`
                : `The thread's worktree is not on a branch (expected "${expected}"): check out "${expected}" before continuing.`,
            ),
          ),
    );
}
