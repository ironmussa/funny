/**
 * Writes to a project's GitHub issues from the Issues tab. Browser-safe: the
 * runner route validates against these limits and the client uses the types.
 */

/** The most issues one delete request takes (deletes run one at a time on GitHub). */
export const MAX_ISSUES_PER_DELETE = 50;

/** What `POST /api/github/issues-delete` answers. */
export interface DeleteIssuesResult {
  deleted: number[];
  failed: Array<{ issueNumber: number; message: string }>;
}

/** The most issues one add-labels request takes (GitHub is written one issue at a time). */
export const MAX_ISSUES_PER_LABEL = 50;

/** The most labels one add-labels request puts on each issue. */
export const MAX_LABELS_PER_ADD = 5;

/** What `POST /api/github/issues-labels` answers. */
export interface AddIssueLabelsResult {
  labeled: number[];
  failed: Array<{ issueNumber: number; message: string }>;
}
