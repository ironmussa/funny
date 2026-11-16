/**
 * Pull requests as the step runner opens them from inside a workspace.
 */

export interface DraftPullRequest {
  /** The workspace (repository checkout) the pull request is opened from. */
  cwd: string;
  title: string;
  body: string;
  /** Branch the pull request targets. */
  base: string;
  /** Branch with the run's commits, already pushed. */
  head: string;
}

export type OpenPullRequestResult = { ok: true; url: string } | { ok: false; error: string };

export interface PullRequestOpener {
  /** Open `pr` as a draft pull request. */
  openDraft(pr: DraftPullRequest): Promise<OpenPullRequestResult>;
}
