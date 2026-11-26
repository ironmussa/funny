/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * What the factory reads and makes of branches for its lanes (openspec
 * factory-lanes): a lane's branch cut from the branch the factory merges into,
 * whether a branch contains a commit, and the commit a pull request's merge made.
 * Part of `createFactoryRepoReads`, which supplies `mergeTarget`.
 */
import type { GithubCallError, RepoGithub } from '@funny/core/github-app';
import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

export function createFactoryBranchReads(
  repo: string,
  github: RepoGithub,
  mergeTarget: () => ResultAsync<string, GithubCallError>,
) {
  return {
    /**
     * Make `branch` from the head of the branch the factory merges into, when
     * GitHub has no such branch (change factory-lanes, D1): `created`, or
     * `exists` when it was there already (also when another admission made it
     * a moment ago).
     */
    ensureBranch(branch: string): ResultAsync<'created' | 'exists', GithubCallError> {
      const ref = (name: string) =>
        `/repos/${repo}/git/ref/heads/${name.split('/').map(encodeURIComponent).join('/')}`;
      const made = (): ResultAsync<'created' | 'exists', GithubCallError> =>
        mergeTarget()
          .andThen((base) => github.json<{ object: { sha: string } }>(repo, 'GET', ref(base)))
          .andThen((head) =>
            github
              .json(repo, 'POST', `/repos/${repo}/git/refs`, {
                ref: `refs/heads/${branch}`,
                sha: head.object.sha,
              })
              .map(() => 'created' as const)
              // 422: the reference exists already.
              .orElse((error) =>
                error.status === 422
                  ? okAsync<'created' | 'exists', GithubCallError>('exists')
                  : errAsync<'created' | 'exists', GithubCallError>(error),
              ),
          );
      return github
        .json(repo, 'GET', ref(branch))
        .map(() => 'exists' as const)
        .orElse((error) =>
          error.status === 404 ? made() : errAsync<'created' | 'exists', GithubCallError>(error),
        );
    },

    /**
     * Whether `branch` contains commit `sha` (change factory-lanes, D5): what a
     * run merged into another branch counts for a run on `branch` only then.
     */
    branchContains(branch: string, sha: string): ResultAsync<boolean, GithubCallError> {
      return (
        github
          .json<{ status?: string }>(repo, 'GET', `/repos/${repo}/compare/${branch}...${sha}`)
          // `sha` compared to `branch`: behind or identical means every commit of it is in the branch.
          .map((compare) => compare.status === 'behind' || compare.status === 'identical')
      );
    },

    /** The commit merged pull request `number` made, or null when it is not merged. */
    mergeCommit(number: number): ResultAsync<string | null, GithubCallError> {
      return github
        .json<{ merged?: boolean; merge_commit_sha?: string | null }>(
          repo,
          'GET',
          `/repos/${repo}/pulls/${number}`,
        )
        .map((pull) => (pull.merged && pull.merge_commit_sha ? pull.merge_commit_sha : null));
    },
  };
}
