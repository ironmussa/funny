/**
 * Publishing a review verdict on a pull request (change factory-agent-roles):
 * a review comment that never approves, and a commit status a repository can
 * require. Called with a repository-scoped token through `RepoGithub`.
 */

import type { ResultAsync } from 'neverthrow';

import type { GithubCallError, RepoGithub } from './repo-github.js';

/** The commit status the issue factory sets for each review verdict. */
export const REVIEW_STATUS_CONTEXT = 'funny/review';

/** GitHub refuses a status description longer than this. */
const MAX_STATUS_DESCRIPTION = 140;

/**
 * Post `body` as a pull request review on `commitId` with the event `COMMENT`:
 * it neither approves nor requests changes, so it never counts toward (or
 * against) a human approval requirement. Needs `pull_requests: write`.
 */
export function commentReview(
  github: RepoGithub,
  repo: string,
  number: number,
  review: { commitId: string; body: string },
): ResultAsync<void, GithubCallError> {
  return github
    .json(repo, 'POST', `/repos/${repo}/pulls/${number}/reviews`, {
      commit_id: review.commitId,
      body: review.body,
      event: 'COMMENT',
    })
    .map(() => undefined);
}

export interface CommitStatusInput {
  context: string;
  state: 'success' | 'failure' | 'pending' | 'error';
  description: string;
  targetUrl?: string;
}

/** The body of GitHub's create-commit-status request. */
interface CommitStatusBody {
  state: CommitStatusInput['state'];
  context: string;
  description: string;
  target_url?: string;
}

/** Set a commit status on `sha`. Needs `statuses: write`. */
export function setCommitStatus(
  github: RepoGithub,
  repo: string,
  sha: string,
  status: CommitStatusInput,
): ResultAsync<void, GithubCallError> {
  const body: CommitStatusBody = {
    state: status.state,
    context: status.context,
    description: status.description.slice(0, MAX_STATUS_DESCRIPTION),
  };
  if (status.targetUrl) body.target_url = status.targetUrl;
  return github.json(repo, 'POST', `/repos/${repo}/statuses/${sha}`, body).map(() => undefined);
}
