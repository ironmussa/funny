/**
 * GitHub's merge queue for a pull request (change factory-agent-roles, D8):
 * whether a base branch requires it, adding a pull request to it, and where
 * the pull request stands. Where the queue is required, GitHub itself tests
 * each change on the current base and merges it; the issue factory only
 * enqueues and follows.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { GithubCallError, GithubRequestBody, RepoGithub } from './repo-github.js';

/** A branch as path segments: `release/1.x` keeps its slashes. */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

interface RestBranchRule {
  type: string;
}

/**
 * Whether an active rule of `branch` requires the merge queue
 * (`GET /rules/branches/{branch}`). False where rules are not available.
 */
export function requiresMergeQueue(
  github: RepoGithub,
  repo: string,
  branch: string,
): ResultAsync<boolean, GithubCallError> {
  return (
    github
      .json<RestBranchRule[]>(
        repo,
        'GET',
        `/repos/${repo}/rules/branches/${refPath(branch)}?per_page=100`,
      )
      .map((rules) => rules.some((rule) => rule.type === 'merge_queue'))
      // No rules for the branch (404), or a repository whose plan has no rules
      // at all (403, a private repository on GitHub Free): nothing requires the
      // queue. Seen on a real private repository, where every merge failed here.
      .orElse((e) => (e.status === 404 || e.status === 403 ? okAsync(false) : errAsync(e)))
  );
}

interface GraphqlAnswer<T> {
  data?: T | null;
  errors?: Array<{ message: string }>;
}

const PULL_REQUEST_QUEUE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id merged state mergeQueueEntry { state } }
  }
}`;

const ENQUEUE = `mutation($id: ID!, $head: GitObjectID) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) {
    mergeQueueEntry { state }
  }
}`;

interface QueueQuery {
  repository?: {
    pullRequest?: {
      id: string;
      merged: boolean;
      state: string;
      mergeQueueEntry?: { state: string } | null;
    } | null;
  } | null;
}

export type MergeQueueState =
  /** In the queue: GitHub is testing it on the base, or it waits its turn. */
  | { kind: 'queued'; id: string }
  /** GitHub merged it. */
  | { kind: 'merged'; id: string }
  /** Open and not in the queue: never added, or removed (its checks failed there, or a conflict). */
  | { kind: 'not-queued'; id: string }
  /** Closed without a merge. */
  | { kind: 'closed'; id: string };

function graphql<T>(
  github: RepoGithub,
  repo: string,
  query: string,
  variables: GithubRequestBody,
): ResultAsync<GraphqlAnswer<T>, GithubCallError> {
  return github.json<GraphqlAnswer<T>>(repo, 'POST', '/graphql', { query, variables });
}

/** Where pull request `number` stands in its base branch's merge queue. */
export function mergeQueueState(
  github: RepoGithub,
  repo: string,
  number: number,
): ResultAsync<MergeQueueState, GithubCallError> {
  const [owner, name] = repo.split('/');
  return graphql<QueueQuery>(github, repo, PULL_REQUEST_QUEUE, { owner, name, number }).andThen(
    (answer): ResultAsync<MergeQueueState, GithubCallError> => {
      const pull = answer.data?.repository?.pullRequest;
      if (!pull) {
        return errAsync({
          message: `GitHub did not answer the merge queue state of #${number}: ${answer.errors?.[0]?.message ?? 'no pull request'}`,
        });
      }
      if (pull.merged) return okAsync({ kind: 'merged', id: pull.id });
      if (pull.mergeQueueEntry) return okAsync({ kind: 'queued', id: pull.id });
      return okAsync({ kind: pull.state === 'OPEN' ? 'not-queued' : 'closed', id: pull.id });
    },
  );
}

export type EnqueueResult =
  | { kind: 'queued' }
  /** The head is no longer `expectedHeadSha`. */
  | { kind: 'head-moved' }
  /** GitHub refused: its reason (checks not ready, a rule, a conflict). */
  | { kind: 'refused'; reason: string };

/**
 * Add the pull request (its GraphQL `id`) to the merge queue, only while its
 * head is `expectedHeadSha`.
 */
export function enqueuePullRequest(
  github: RepoGithub,
  repo: string,
  id: string,
  expectedHeadSha: string,
): ResultAsync<EnqueueResult, GithubCallError> {
  return graphql<unknown>(github, repo, ENQUEUE, { id, head: expectedHeadSha }).map(
    (answer): EnqueueResult => {
      const error = answer.errors?.[0]?.message;
      if (!error) return { kind: 'queued' };
      // Already in the queue (a resumed run): it is where it should be.
      if (/already (queued|in the merge queue)/i.test(error)) return { kind: 'queued' };
      if (/head (sha|oid)|expected head/i.test(error)) return { kind: 'head-moved' };
      return { kind: 'refused', reason: error };
    },
  );
}
