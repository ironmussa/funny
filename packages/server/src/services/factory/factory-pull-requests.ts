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
  createRepoCheckOps,
  createRepoGithub,
  REGRESSION_PROOF_CHECK,
  type CiState,
  type GithubCallError,
  type MergeMethod,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { serverActivities, type ServerActivities } from '../activities/server-activities.js';
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
  /** Only these checks must be green (the flow's `wait_ci.required_checks`); all when absent. */
  requiredChecks?: readonly string[];
  /**
   * Merge exactly this commit (the one the regression proof proved): a direct
   * merge that GitHub refuses when the head moved.
   */
  sha?: string;
  /**
   * With `sha`: when GitHub refuses the direct merge for an unmet requirement
   * (a review, checks still running), enable auto-merge, but only when GitHub
   * holds the proof's check on the base branch, pinned to this App. Set only
   * when the check was published for `sha`.
   */
  autoMergeWhenHeld?: boolean;
}

/** The pull request's head now, what it merges into, and whether auto-merge is on. */
export interface FactoryPullHead {
  sha: string;
  baseRef: string;
  autoMerge: boolean;
}

/** A regression proof's check run, published on its commit. */
export interface FactoryProofCheck {
  headSha: string;
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
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

const PR_NUMBER = /\/pull\/(\d+)(?:$|[/?#])/;

/** The number of a pull request from its URL, or null. */
export function prNumberOf(url: string | null): number | null {
  const number = url ? Number(PR_NUMBER.exec(url)?.[1]) : NaN;
  return Number.isInteger(number) ? number : null;
}

export interface FactoryPullRequests {
  /** With `required`, only those checks count (see `PullRequestCi.ciState`). */
  ciState(
    pr: FactoryPullRequestRef,
    required?: readonly string[],
  ): ResultAsync<CiState, FactoryPullRequestError>;
  /** Whether the pull request is still open, was merged, or was closed without a merge. */
  prState(
    pr: FactoryPullRequestRef,
  ): ResultAsync<'open' | 'merged' | 'closed', FactoryPullRequestError>;
  /** The pull request's head commit now, its base branch, and whether auto-merge is on. */
  pullHead(pr: FactoryPullRequestRef): ResultAsync<FactoryPullHead, FactoryPullRequestError>;
  /**
   * Publish the proof as the `funny/regression-proof` check run, with a
   * server-only token that can write checks and nothing else.
   */
  publishProofCheck(
    pr: FactoryPullRequestRef,
    check: FactoryProofCheck,
  ): ResultAsync<void, FactoryPullRequestError>;
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
  /** A token that may only write checks (`issueCheckPublisher`); absent: no check is published. */
  issueCheckPublisher?(repo: string, ownerToken: string | null): ResultAsync<RepoToken, IssueError>;
  /** The connected App's id, to tell a check pinned to it; absent or null: nothing is held. */
  appId?(): ResultAsync<string | null, IssueError>;
  fetch?: typeof fetch;
  api?: string;
  /** Records each merge as a `factory.merge` activity of the enabler (default: the server's). */
  activities?: Pick<ServerActivities, 'recordServerActivity'>;
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
  const activities = deps.activities ?? serverActivities;

  /**
   * A merge the factory made for its enabler (track-funny-actions): the merged
   * pull request, and the remote branch when it was deleted. A branch left
   * behind fails the activity, not the merge step.
   */
  const recordMerge = (pr: FactoryPullRequestRef, branchError: string | null, deleted: boolean) =>
    activities.recordServerActivity(
      {
        kind: 'factory.merge',
        userId: pr.userId,
        projectId: pr.projectId,
        title: `Merged ${pr.repo}#${pr.number}`,
        input: { prNumber: pr.number },
        origin: 'system',
      },
      branchError
        ? {
            ok: false,
            error: `Merged, but the branch ${pr.branch} could not be deleted: ${branchError}`,
            effects: [{ effect: 'pr-merged', target: `${pr.repo}#${pr.number}` }],
          }
        : {
            ok: true,
            effects: [
              { effect: 'pr-merged', target: `${pr.repo}#${pr.number}` },
              ...(deleted && pr.branch
                ? [{ effect: 'remote-branch-deleted' as const, target: pr.branch }]
                : []),
            ],
          },
    );

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

  const repoGithubFor = (pr: FactoryPullRequestRef, needs: AccessLevel) =>
    createRepoGithub({
      tokenFor: tokenFor(pr, needs),
      fetch: deps.fetch,
      api: deps.api,
      userAgent: 'funny-issue-factory',
    });
  const pullRequestsFor = (pr: FactoryPullRequestRef, needs: AccessLevel) =>
    createPullRequestCi(repoGithubFor(pr, needs));

  /** Whether GitHub holds the proof's check on `baseRef`, pinned to this App. */
  const proofCheckHeld = (
    pr: FactoryPullRequestRef,
    baseRef: string,
  ): ResultAsync<boolean, FactoryPullRequestError> => {
    if (!deps.appId || !baseRef) return okAsync(false);
    return deps
      .appId()
      .mapErr((error) => accessError(error, pr.repo))
      .andThen((appId) =>
        appId && /^\d+$/.test(appId)
          ? createRepoCheckOps(repoGithubFor(pr, 'read'))
              .isCheckHeldByApp(pr.repo, baseRef, REGRESSION_PROOF_CHECK, Number(appId))
              .mapErr(callError)
          : okAsync(false),
      );
  };

  /**
   * Merge `sha` directly. Refused because the head moved: not merged. Refused
   * for an unmet requirement: auto-merge when allowed and GitHub holds the
   * proof's check, else not merged with how to let the factory auto-merge.
   */
  const mergePinned = (
    pr: FactoryPullRequestRef,
    sha: string,
    method: MergeMethod,
    options: FactoryMergeOptions,
  ): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> =>
    createRepoCheckOps(repoGithubFor(pr, 'write'))
      .pinnedMerge(pr.repo, pr.number, sha, method)
      .mapErr(callError)
      .andThen((result): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> => {
        if (result.kind === 'merged') {
          return okAsync({ kind: 'merged', method: result.method, branchDeleted: false });
        }
        const refused = `GitHub refused to merge the proved commit ${sha}: ${result.reason}`;
        if (result.headMoved || !options.autoMergeWhenHeld) {
          return okAsync({ kind: 'not-mergeable', reason: refused });
        }
        return pullRequestsFor(pr, 'read')
          .mergeState(pr.repo, pr.number)
          .mapErr(callError)
          .andThen((state) =>
            state.headSha !== sha
              ? okAsync<FactoryMergeOutcome, FactoryPullRequestError>({
                  kind: 'not-mergeable',
                  reason: `The pull request head moved from the proved commit ${sha}.`,
                })
              : proofCheckHeld(pr, state.baseRef).andThen((held) =>
                  held
                    ? autoMergeOrMerge(pullRequestsFor(pr, 'write'), pr, method, sha)
                    : okAsync<FactoryMergeOutcome, FactoryPullRequestError>({
                        kind: 'not-mergeable',
                        reason: `${refused}. The factory enables auto-merge only where GitHub holds the proof: require the "${REGRESSION_PROOF_CHECK}" check from this GitHub App on ${state.baseRef || 'the base branch'} (a ruleset or branch protection).`,
                      }),
                ),
          );
      });

  return {
    ciState(pr, required) {
      return pullRequestsFor(pr, 'read').ciState(pr.repo, pr.number, required).mapErr(callError);
    },

    prState(pr) {
      return pullRequestsFor(pr, 'read')
        .mergeState(pr.repo, pr.number)
        .map((merge) => merge.state)
        .mapErr(callError);
    },

    pullHead(pr) {
      return pullRequestsFor(pr, 'read')
        .mergeState(pr.repo, pr.number)
        .map((merge) => ({
          sha: merge.headSha,
          baseRef: merge.baseRef,
          autoMerge: merge.autoMerge,
        }))
        .mapErr(callError);
    },

    publishProofCheck(pr, check) {
      const issuer = deps.issueCheckPublisher;
      if (!issuer) {
        return errAsync<void, FactoryPullRequestError>({
          kind: 'not-configured',
          message: 'No check publisher is configured.',
        });
      }
      const github = createRepoGithub({
        tokenFor: (repo) =>
          ResultAsync.fromSafePromise(deps.ownerToken(pr.userId, pr.projectId))
            .andThen((ownerToken) =>
              issuer(repo, ownerToken).mapErr((error) => accessError(error, repo)),
            )
            .map((token) => token.token),
        fetch: deps.fetch,
        api: deps.api,
        userAgent: 'funny-issue-factory',
      });
      return createRepoCheckOps(github)
        .createCheckRun({
          repo: pr.repo,
          headSha: check.headSha,
          name: REGRESSION_PROOF_CHECK,
          conclusion: check.conclusion,
          title: check.title,
          summary: check.summary,
        })
        .map(() => undefined)
        .mapErr(callError);
    },

    merge(pr, options = {}) {
      const github = pullRequestsFor(pr, 'write');
      return github
        .ciState(pr.repo, pr.number, options.requiredChecks)
        .mapErr(callError)
        .andThen((ci): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> => {
          if (ci.kind !== 'green') return okAsync({ kind: 'not-green', ci });
          const merged = options.sha
            ? mergePinned(pr, options.sha, options.method ?? 'squash', options)
            : autoMergeOrMerge(github, pr, options.method);
          return merged.andThen(
            (outcome): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> => {
              if (outcome.kind !== 'merged') return okAsync(outcome);
              if (!options.deleteBranch || !pr.branch) {
                return ResultAsync.fromSafePromise(recordMerge(pr, null, false)).map(() => outcome);
              }
              return github
                .deleteBranch(pr.repo, pr.branch)
                .map(() => null)
                .orElse((error) => okAsync<string | null, never>(error.message))
                .andThen((branchError) =>
                  // The merge stands; a branch left behind is not a failed merge.
                  ResultAsync.fromSafePromise(recordMerge(pr, branchError, !branchError)).map(
                    (): FactoryMergeOutcome => ({ ...outcome, branchDeleted: !branchError }),
                  ),
                );
            },
          );
        });
    },
  };
}

/** GitHub's auto-merge, or a merge now when the pull request already meets every requirement. */
function autoMergeOrMerge(
  github: ReturnType<typeof createPullRequestCi>,
  pr: FactoryPullRequestRef,
  method: MergeMethod | undefined,
  /** Only this head: a push since it was proved enables nothing. */
  expectedHeadSha?: string,
): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> {
  return github
    .enableAutoMerge(pr.repo, pr.number, method, expectedHeadSha)
    .mapErr(callError)
    .map((result): FactoryMergeOutcome => {
      if (result.kind === 'enabled') return { kind: 'auto-merge-enabled', method: result.method };
      if (result.kind !== 'merged') return { kind: 'not-mergeable', reason: result.reason };
      return { kind: 'merged', method: result.method, branchDeleted: false };
    });
}
