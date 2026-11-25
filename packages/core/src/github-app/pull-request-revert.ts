/**
 * Reverting a merged pull request (change factory-agent-roles, D10): GitHub
 * opens a pull request that undoes it (`revertPullRequest`). Opened, never
 * merged here: a person merges a revert.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { GithubCallError, GithubRequestBody, RepoGithub } from './repo-github.js';

interface GraphqlAnswer<T> {
  data?: T | null;
  errors?: Array<{ message: string }>;
}

const PULL_REQUEST_ID = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id merged } }
}`;

const REVERT = `mutation($id: ID!, $title: String, $body: String) {
  revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) {
    revertPullRequest { url number }
  }
}`;

interface IdQuery {
  repository?: { pullRequest?: { id: string; merged: boolean } | null } | null;
}

interface RevertMutation {
  revertPullRequest?: { revertPullRequest?: { url: string; number: number } | null } | null;
}

export interface RevertPullRequest {
  /** The pull request that undoes the merge. */
  url: string;
  number: number;
}

/**
 * Open a pull request that reverts merged pull request `number`. An error
 * when it is not merged, or GitHub cannot build the revert (a conflict with
 * later commits).
 */
export function revertPullRequest(
  github: RepoGithub,
  repo: string,
  number: number,
  text: { title?: string; body?: string } = {},
): ResultAsync<RevertPullRequest, GithubCallError> {
  const [owner, name] = repo.split('/');
  const graphql = <T>(query: string, variables: GithubRequestBody) =>
    github.json<GraphqlAnswer<T>>(repo, 'POST', '/graphql', { query, variables });
  return graphql<IdQuery>(PULL_REQUEST_ID, { owner, name, number }).andThen(
    (found): ResultAsync<RevertPullRequest, GithubCallError> => {
      const pull = found.data?.repository?.pullRequest;
      if (!pull) return errAsync({ message: `Pull request #${number} was not found` });
      if (!pull.merged) return errAsync({ message: `Pull request #${number} is not merged` });
      return graphql<RevertMutation>(REVERT, { id: pull.id, ...text }).andThen((answer) => {
        const reverted = answer.data?.revertPullRequest?.revertPullRequest;
        if (reverted) return okAsync({ url: reverted.url, number: reverted.number });
        return errAsync<RevertPullRequest, GithubCallError>({
          message: `GitHub could not open a revert of #${number}: ${answer.errors?.[0]?.message ?? 'no answer'}`,
        });
      });
    },
  );
}
