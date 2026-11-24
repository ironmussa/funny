import {
  ArrowDown,
  ArrowUp,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from 'lucide-react';

/**
 * One glyph per git concept, shared by every surface (sidebar rows, PR badges,
 * timeline cards, dialogs) so the same thing never looks different in two places.
 */

/** Uncommitted changes in the working tree. */
export const GIT_CHANGES_ICON = FileDiff;

/** Commits made but not pushed yet: what a push would send up. */
export const GIT_UNPUSHED_ICON = ArrowUp;

/** Commits on the remote not pulled yet: what a pull would bring down. */
export const GIT_UNPULLED_ICON = ArrowDown;

export type PRState = 'OPEN' | 'MERGED' | 'CLOSED';

/** A pull request by state, as GitHub shows it: a merged PR is not an open one in violet. */
export const PR_STATE_ICON = {
  OPEN: GitPullRequest,
  MERGED: GitMerge,
  CLOSED: GitPullRequestClosed,
} as const satisfies Record<PRState, typeof GitPullRequest>;

/** Text color of a pull request by state, for the borderless git stat chips. */
export const PR_STATE_TEXT_CLASS = {
  OPEN: 'text-git-icon-pushed',
  MERGED: 'text-git-icon-merged',
  CLOSED: 'text-status-error',
} as const satisfies Record<PRState, string>;
