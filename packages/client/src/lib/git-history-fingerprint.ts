import type { ProjectGitStatus } from '@/data/git-status/keys';
import type { GitStatusInfo } from '@funny/shared';


/**
 * Reduce a git status to the fields that move when the commit HISTORY moves,
 * so the History / Graph tabs reload on commits, pushes, pulls and fetches but
 * not on every file edit:
 *
 * - ahead / behind counts and upstream presence → commit, push, pull, fetch,
 *   branch switch.
 * - merged-into-base → merges landing on the base branch.
 * - whether the tree is clean → a commit (including `--amend`, whose counts
 *   don't change) empties the working tree. Only the clean/dirty flip counts,
 *   never the file or line numbers, so agent edits stay silent.
 *
 * Returns `null` while the status is unknown.
 */
export function gitHistoryFingerprint(
  status: GitStatusInfo | ProjectGitStatus | undefined,
): string | null {
  if (!status) return null;
  const clean = (status.dirtyFileCount ?? 0) === 0;
  return [
    status.unpushedCommitCount,
    status.unpulledCommitCount,
    status.hasRemoteBranch ? 1 : 0,
    status.isMergedIntoBase ? 1 : 0,
    clean ? 1 : 0,
  ].join(':');
}
