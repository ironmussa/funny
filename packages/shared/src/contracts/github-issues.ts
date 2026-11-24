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
