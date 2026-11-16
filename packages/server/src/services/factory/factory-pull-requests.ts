/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * A factory run's pull request on GitHub, for the `wait_ci` / `merge` flow
 * steps (change factory-flow-execution, group 2). The GitHub logic is the
 * issue factory's, shared from `@funny/core/github-app`
 * (`createPullRequestCi`); this binds it to the server's GitHub App token for
 * the run's repository, capped by the factory ENABLER's own access
 * (`accessCapToken`), never another user's credentials. A merge needs write
 * access and green checks; nothing here bypasses branch protections.
 */

import {
  createPullRequestCi,
  createRepoGithub,
  type CiState,
  type GithubCallError,
  type MergeMethod,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { AccessLevel, IssueError, RepoToken } from '../github-app/token-issuer.js';

/** The pull request of a run, and whose access caps the token. */
export interface FactoryPullRequestRef {
  /** `owner/name`. */
  repo: string;
  number: number;
  /** The working branch, deleted after a merge when asked. */
  branch?: string;
  /** The factory's enabler. */
  userId: string;
  projectId: string;
}

export type FactoryPullRequestErrorKind =
  | 'not-configured'
  | 'not-installed'
  | 'no-access'
  | 'github-error';

/** Every error names its cause and what to do (spec: GitHub access requirement). */
export interface FactoryPullRequestError {
  kind: FactoryPullRequestErrorKind;
  message: string;
}

export interface FactoryMergeOptions {
  method?: MergeMethod;
  deleteBranch?: boolean;
}

export type FactoryMergeOutcome =
  /** Merged now (its requirements were met). */
  | { kind: 'merged'; method: MergeMethod; branchDeleted: boolean }
  /** GitHub merges it once its remaining requirements (e.g. reviews) are met. */
  | { kind: 'auto-merge-enabled'; method: MergeMethod }
  /** Not merged: its checks are not green. */
  | { kind: 'not-green'; ci: CiState }
  /** Not merged: the repository allows no merge method, or it stopped being mergeable. */
  | { kind: 'not-mergeable'; reason: string };

export interface FactoryPullRequests {
  ciState(pr: FactoryPullRequestRef): ResultAsync<CiState, FactoryPullRequestError>;
  /** Merges only when the checks are green; otherwise answers `not-green` without acting. */
  merge(
    pr: FactoryPullRequestRef,
    options?: FactoryMergeOptions,
  ): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError>;
}

export interface FactoryPullRequestsDeps {
  /**
   * A token for `repo` capped by the owner token's access — in production the
   * issuer of `github-app/token-issuer.ts`, as the watcher's GitHub side uses.
   */
  issue(repo: string, ownerToken: string | null): ResultAsync<RepoToken, IssueError>;
  /** The personal token whose access caps the App token — in production `accessCapToken`. */
  ownerToken(userId: string, projectId: string): Promise<string | null>;
  fetch?: typeof fetch;
  api?: string;
}

/** What to do about each way a token could not be minted. */
function accessError(error: IssueError, repo: string): FactoryPullRequestError {
  switch (error.kind) {
    case 'not-configured':
      return {
        kind: 'not-configured',
        message: `${error.message}. An admin connects the GitHub App in Preferences > GitHub App.`,
      };
    case 'not-installed':
      return {
        kind: 'not-installed',
        message: `The GitHub App is not installed on ${repo}. Install it on that repository.`,
      };
    case 'no-access':
      return {
        kind: 'no-access',
        message: `${error.message}. The factory's enabler needs a GitHub token with access to ${repo} in Settings > Profile.`,
      };
    default:
      return { kind: 'github-error', message: error.message };
  }
}

const callError = (error: GithubCallError): FactoryPullRequestError =>
  error.kind === 'not-installed' || error.kind === 'not-configured' || error.kind === 'no-access'
    ? { kind: error.kind, message: error.message }
    : { kind: 'github-error', message: error.message };

export function createFactoryPullRequests(deps: FactoryPullRequestsDeps): FactoryPullRequests {
  /** A token for the run's repository, refused when the enabler's level is below `needs`. */
  const tokenFor =
    (pr: FactoryPullRequestRef, needs: AccessLevel) =>
    (repo: string): ResultAsync<string, FactoryPullRequestError> =>
      ResultAsync.fromSafePromise(deps.ownerToken(pr.userId, pr.projectId))
        .andThen((ownerToken) =>
          deps.issue(repo, ownerToken).mapErr((error) => accessError(error, repo)),
        )
        .andThen((token) =>
          needs === 'write' && token.level !== 'write'
            ? errAsync<string, FactoryPullRequestError>({
                kind: 'no-access',
                message: `The factory's enabler can only read ${repo}; merging needs write access.`,
              })
            : okAsync(token.token),
        );

  const pullRequestsFor = (pr: FactoryPullRequestRef, needs: AccessLevel) =>
    createPullRequestCi(
      createRepoGithub({
        tokenFor: tokenFor(pr, needs),
        fetch: deps.fetch,
        api: deps.api,
        userAgent: 'funny-issue-factory',
      }),
    );

  return {
    ciState(pr) {
      return pullRequestsFor(pr, 'read').ciState(pr.repo, pr.number).mapErr(callError);
    },

    merge(pr, options = {}) {
      const github = pullRequestsFor(pr, 'write');
      return github
        .ciState(pr.repo, pr.number)
        .mapErr(callError)
        .andThen((ci): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> => {
          if (ci.kind !== 'green') return okAsync({ kind: 'not-green', ci });
          return github
            .enableAutoMerge(pr.repo, pr.number, options.method)
            .mapErr(callError)
            .andThen((result): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> => {
              if (result.kind === 'enabled') {
                return okAsync({ kind: 'auto-merge-enabled', method: result.method });
              }
              if (result.kind !== 'merged') {
                return okAsync({ kind: 'not-mergeable', reason: result.reason });
              }
              if (!options.deleteBranch || !pr.branch) {
                return okAsync({ kind: 'merged', method: result.method, branchDeleted: false });
              }
              return github
                .deleteBranch(pr.repo, pr.branch)
                .map((): FactoryMergeOutcome => ({
                  kind: 'merged',
                  method: result.method,
                  branchDeleted: true,
                }))
                .orElse(() =>
                  // The merge stands; a branch left behind is not a failed merge.
                  okAsync<FactoryMergeOutcome, FactoryPullRequestError>({
                    kind: 'merged',
                    method: result.method,
                    branchDeleted: false,
                  }),
                );
            });
        });
    },
  };
}
