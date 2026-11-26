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

    /** The commit `branch` is at, or null when GitHub has no such branch. */
    branchHead(branch: string): ResultAsync<string | null, GithubCallError> {
      return github
        .json<{ object: { sha: string } }>(repo, 'GET', refPath(repo, branch))
        .map((ref): string | null => ref.object.sha)
        .orElse((error) =>
          error.status === 404
            ? okAsync<string | null, GithubCallError>(null)
            : errAsync<string | null, GithubCallError>(error),
        );
    },

    /**
     * Put `branch` at `sha`, making it when it does not exist. Forced: the
     * branch is the factory's own scratch branch of a lane sync, started
     * again from the lane's head each time.
     */
    resetBranch(branch: string, sha: string): ResultAsync<void, GithubCallError> {
      return github
        .json(repo, 'PATCH', `/repos/${repo}/git/refs/heads/${encodeBranch(branch)}`, {
          sha,
          force: true,
        })
        .map(() => undefined)
        .orElse((error) =>
          error.status === 404 || error.status === 422
            ? github
                .json(repo, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
                .map(() => undefined)
            : errAsync<void, GithubCallError>(error),
        );
    },

    /**
     * Merge commit `sha` into `branch` on GitHub, as a merge commit: `merged`,
     * `nothing` when the branch already has it, or `conflict` (nothing is
     * written then).
     */
    mergeInto(
      branch: string,
      sha: string,
      message: string,
    ): ResultAsync<'merged' | 'nothing' | 'conflict', GithubCallError> {
      type Outcome = 'merged' | 'nothing' | 'conflict';
      return (
        github
          .json<{ sha?: string } | undefined>(repo, 'POST', `/repos/${repo}/merges`, {
            base: branch,
            head: sha,
            commit_message: message,
          })
          // 204: already merged, no body.
          .map((made): Outcome => (made?.sha ? 'merged' : 'nothing'))
          .orElse((error) =>
            error.status === 409
              ? okAsync<Outcome, GithubCallError>('conflict')
              : errAsync<Outcome, GithubCallError>(error),
          )
      );
    },

    /** Open a pull request from `head` into `base`, or answer the open one there is. */
    openPullRequest(input: {
      head: string;
      base: string;
      title: string;
      body: string;
    }): ResultAsync<number, GithubCallError> {
      const [owner] = repo.split('/');
      const existing = () =>
        github
          .json<Array<{ number: number }>>(
            repo,
            'GET',
            `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&state=open`,
          )
          .map((pulls) => pulls[0]?.number ?? null);
      return github
        .json<{ number: number }>(repo, 'POST', `/repos/${repo}/pulls`, input)
        .map((pull) => pull.number)
        .orElse((error) =>
          error.status !== 422
            ? errAsync<number, GithubCallError>(error)
            : existing().andThen((number) =>
                number === null
                  ? errAsync<number, GithubCallError>(error)
                  : okAsync<number, GithubCallError>(number),
              ),
        );
    },

    /** Delete `branch`; one that is gone already is fine. */
    deleteBranch(branch: string): ResultAsync<void, GithubCallError> {
      return github
        .json(repo, 'DELETE', `/repos/${repo}/git/refs/heads/${encodeBranch(branch)}`)
        .map(() => undefined)
        .orElse((error) =>
          error.status === 404 || error.status === 422
            ? okAsync<void, GithubCallError>(undefined)
            : errAsync<void, GithubCallError>(error),
        );
    },
  };
}

const encodeBranch = (name: string) => name.split('/').map(encodeURIComponent).join('/');
const refPath = (repo: string, branch: string) =>
  `/repos/${repo}/git/ref/heads/${encodeBranch(branch)}`;

/** What a lane sync does to branches and pull requests (`factory-lane-sync.ts`). */
export type FactoryLaneBranches = Pick<
  ReturnType<typeof createFactoryBranchReads>,
  'branchHead' | 'resetBranch' | 'mergeInto' | 'openPullRequest' | 'deleteBranch' | 'branchContains'
>;
