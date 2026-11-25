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
  baseChangesSince,
  baseDistance,
  commentReview,
  commitParents,
  createGithubIntegration,
  createPullRequestCi,
  type PullRequestCi,
  createRepoCheckOps,
  createRepoGithub,
  enqueuePullRequest,
  listPullRequestFiles,
  mergeQueueState,
  REGRESSION_PROOF_CHECK,
  requiresMergeQueue,
  REVIEW_STATUS_CONTEXT,
  setCommitStatus,
  updateBranch,
  type BaseChanges,
  type BaseDistance,
  type CiState,
  type EnqueueResult,
  type GithubCallError,
  type IntegrationProvider,
  type MergeMethod,
  type MergeQueueState,
  type PullRequestFiles,
  type UpdateBranchResult,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { serverActivities, type ServerActivities } from '../activities/server-activities.js';
import type { AccessLevel, IssueError, RepoToken } from '../github-app/token-issuer.js';
import { retryTransientGithub } from './factory-github-retry.js';

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
  /** Stops the wait before a merge GitHub failed to answer is tried again (the run was stopped). */
  signal?: AbortSignal;
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

/** A review verdict as it is put on the pull request. */
export interface FactoryReviewPublication {
  /** The reviewed commit. */
  sha: string;
  /** Whether the verdict allows a merge (the status' state). */
  allowsMerge: boolean;
  /**
   * The review comment (Markdown). Absent for a verdict carried to a commit
   * that only merges the base in: the pull request already has its comment,
   * and only the new head's status is set.
   */
  body?: string;
  /** The status' one-line description. */
  description: string;
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

/** What a newer run of the same issue replaced: the issue, and the newer run's pull request. */
export interface FactoryReplacedBy {
  issueNumber: number | null;
  /** The newer run's pull request number, or null while it has none. */
  prNumber: number | null;
}

export type FactoryCloseOutcome =
  /** Closed now; `branchDeleted` is false when its branch could not be deleted. */
  | { kind: 'closed'; branchDeleted: boolean }
  /** Someone had closed it: only its branch was left to delete. */
  | { kind: 'already-closed'; branchDeleted: boolean }
  /** It was merged: nothing is closed and its branch is left alone. */
  | { kind: 'merged' };

/** The comment left on a pull request closed because a newer run replaced its run. */
function replacedComment(by: FactoryReplacedBy): string {
  const issue = by.issueNumber === null ? 'this change' : `#${by.issueNumber}`;
  const where = by.prNumber === null ? '' : ` Its pull request is #${by.prNumber}.`;
  return `Closed from funny's issue factory: a newer run of ${issue} replaced the run that opened this pull request.${where}`;
}

const PR_NUMBER = /\/pull\/(\d+)(?:$|[/?#])/;

/** The number of a pull request from its URL, or null. */
export function prNumberOf(url: string | null): number | null {
  const number = url ? Number(PR_NUMBER.exec(url)?.[1]) : NaN;
  return Number.isInteger(number) ? number : null;
}

export interface FactoryPullRequests {
  /**
   * The merge queue's host for one enabler (openspec factory-integration D4):
   * every call uses the App token capped by that user's access, for writing.
   * Absent (tests): no batch queue; `merge` takes the serial path.
   */
  integrationFor?(owner: { userId: string; projectId: string }): IntegrationProvider;
  /** Point the pull request at another base branch (a stacked run, once its blocker landed: D10). */
  retarget?(pr: FactoryPullRequestRef, base: string): ResultAsync<void, FactoryPullRequestError>;
  /** With `required`, only those checks count (see `PullRequestCi.ciState`). */
  ciState(
    pr: FactoryPullRequestRef,
    required?: readonly string[],
  ): ResultAsync<CiState, FactoryPullRequestError>;
  /** Whether the pull request is still open, was merged, or was closed without a merge. */
  prState(
    pr: FactoryPullRequestRef,
  ): ResultAsync<'open' | 'merged' | 'closed', FactoryPullRequestError>;
  /**
   * Close, without merging, the pull request of a run that a newer run of its
   * issue replaced: a comment saying so, the close, then its branch (the pull
   * requests stacked on it move to its base first). A merged pull request is
   * left as it is. The caller has checked that the run was replaced.
   * Absent (tests): the close is refused.
   */
  closeReplaced?(
    pr: FactoryPullRequestRef,
    by: FactoryReplacedBy,
    /** Who closed it, for its activity: a member (default), or the factory itself after a merge. */
    origin?: 'user' | 'system',
  ): ResultAsync<FactoryCloseOutcome, FactoryPullRequestError>;
  /** The pull request's head commit now, its base branch, and whether auto-merge is on. */
  pullHead(pr: FactoryPullRequestRef): ResultAsync<FactoryPullHead, FactoryPullRequestError>;
  /** The files the pull request changes, with their patches (the server's own checks read them). */
  changedFiles(pr: FactoryPullRequestRef): ResultAsync<PullRequestFiles, FactoryPullRequestError>;
  /**
   * Publish the proof as the `funny/regression-proof` check run, with a
   * server-only token that can write checks and nothing else.
   */
  publishProofCheck(
    pr: FactoryPullRequestRef,
    check: FactoryProofCheck,
  ): ResultAsync<void, FactoryPullRequestError>;
  /** How far `headSha` is behind (and ahead of) the base branch `baseRef`. */
  baseDistance(
    pr: FactoryPullRequestRef,
    baseRef: string,
    headSha: string,
  ): ResultAsync<BaseDistance, FactoryPullRequestError>;
  /**
   * Have GitHub merge the base branch into the pull request's branch, only
   * while its head is `headSha` (a merge commit, never a rebase). Tried again
   * when GitHub itself fails (a 5xx, no answer); `signal` stops that wait.
   */
  updateBranch(
    pr: FactoryPullRequestRef,
    headSha: string,
    signal?: AbortSignal,
  ): ResultAsync<UpdateBranchResult, FactoryPullRequestError>;
  /** The parents of a commit of the repository, first parent first. */
  commitParents(
    pr: FactoryPullRequestRef,
    sha: string,
  ): ResultAsync<string[], FactoryPullRequestError>;
  /** What the base branch gained that `headSha` does not have. */
  baseChanges(
    pr: FactoryPullRequestRef,
    headSha: string,
    baseRef: string,
  ): ResultAsync<BaseChanges, FactoryPullRequestError>;
  /** Whether the base branch `baseRef` requires GitHub's merge queue. */
  mergeQueueRequired(
    pr: FactoryPullRequestRef,
    baseRef: string,
  ): ResultAsync<boolean, FactoryPullRequestError>;
  /** Add the pull request to GitHub's merge queue, only while its head is `headSha`. */
  enqueue(
    pr: FactoryPullRequestRef,
    headSha: string,
  ): ResultAsync<EnqueueResult, FactoryPullRequestError>;
  /** Where the pull request stands in the merge queue. */
  queueState(
    pr: FactoryPullRequestRef,
  ): ResultAsync<MergeQueueState['kind'], FactoryPullRequestError>;
  /**
   * Put a review verdict on the pull request: a review comment that never
   * approves, then the `funny/review` status on the reviewed commit with a
   * server-only token. The comment failing is the error; `status` says whether
   * the status was set (false while the installation has not accepted
   * `statuses: write`).
   */
  publishReview(
    pr: FactoryPullRequestRef,
    review: FactoryReviewPublication,
  ): ResultAsync<{ status: boolean }, FactoryPullRequestError>;
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
  /** A token that may only write commit statuses (`issueStatusPublisher`); absent: no status is set. */
  issueStatusPublisher?(
    repo: string,
    ownerToken: string | null,
  ): ResultAsync<RepoToken, IssueError>;
  /** The connected App's id, to tell a check pinned to it; absent or null: nothing is held. */
  appId?(): ResultAsync<string | null, IssueError>;
  fetch?: typeof fetch;
  api?: string;
  /** Records each merge as a `factory.merge` activity of the enabler (default: the server's). */
  activities?: Pick<ServerActivities, 'recordServerActivity'>;
  /** The waits before a write GitHub failed to answer is tried again (default: three, see `factory-github-retry.ts`). */
  transientRetryDelaysMs?: readonly number[];
  /** Injected wait between those attempts, for tests. */
  retrySleep?: (ms: number) => PromiseLike<void>;
}

/** How a write GitHub failed to answer is tried again (`factory-github-retry.ts`). */
const retryOptionsOf = (
  deps: Pick<FactoryPullRequestsDeps, 'transientRetryDelaysMs' | 'retrySleep'>,
  what: string,
  signal: AbortSignal | undefined,
) => ({ what, signal, delaysMs: deps.transientRetryDelaysMs, sleep: deps.retrySleep });

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

/**
 * A merge the factory made for its enabler (track-funny-actions): the merged
 * pull request, and the remote branch when it was deleted. A branch left
 * behind fails the activity, not the merge step.
 */
function recordFactoryMerge(
  activities: NonNullable<FactoryPullRequestsDeps['activities']>,
  pr: FactoryPullRequestRef,
  branchError: string | null,
  deleted: boolean,
) {
  return activities.recordServerActivity(
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
}

/** The input of a `factory.close-pr` activity (`ACTIVITY_KINDS`). */
type ClosePrActivityInput = {
  prNumber: number;
  issueNumber?: number;
  replacedBy?: number;
};

/**
 * A replaced run's pull request a member closed (track-funny-actions). A
 * branch left behind fails the activity, not the close.
 */
function recordFactoryClose(
  activities: NonNullable<FactoryPullRequestsDeps['activities']>,
  pr: FactoryPullRequestRef,
  by: FactoryReplacedBy,
  result: { closed: boolean; branchError: string | null; deleted: boolean },
  origin: 'user' | 'system',
) {
  const closed = result.closed
    ? [{ effect: 'pr-closed' as const, target: `${pr.repo}#${pr.number}` }]
    : [];
  const input: ClosePrActivityInput = { prNumber: pr.number };
  if (by.issueNumber !== null) input.issueNumber = by.issueNumber;
  if (by.prNumber !== null) input.replacedBy = by.prNumber;
  return activities.recordServerActivity(
    {
      kind: 'factory.close-pr',
      userId: pr.userId,
      projectId: pr.projectId,
      title: `Closed ${pr.repo}#${pr.number}`,
      input,
      origin,
    },
    result.branchError
      ? {
          ok: false,
          error: `Closed, but the branch ${pr.branch} could not be deleted: ${result.branchError}`,
          effects: closed,
        }
      : {
          ok: true,
          effects: [
            ...closed,
            ...(result.deleted && pr.branch
              ? [{ effect: 'remote-branch-deleted' as const, target: pr.branch }]
              : []),
          ],
        },
  );
}

/** `FactoryPullRequests.closeReplaced`, over the enabler's write-capped GitHub calls. */
function closeReplacedPullRequest(
  github: PullRequestCi,
  activities: NonNullable<FactoryPullRequestsDeps['activities']>,
  pr: FactoryPullRequestRef,
  by: FactoryReplacedBy,
  origin: 'user' | 'system' = 'user',
): ResultAsync<FactoryCloseOutcome, FactoryPullRequestError> {
  return github
    .mergeState(pr.repo, pr.number)
    .mapErr(callError)
    .andThen((merge): ResultAsync<FactoryCloseOutcome, FactoryPullRequestError> => {
      if (merge.state === 'merged') return okAsync({ kind: 'merged' });
      const wasOpen = merge.state === 'open';
      const closed = wasOpen
        ? github
            .comment(pr.repo, pr.number, replacedComment(by))
            .andThen(() => github.close(pr.repo, pr.number))
        : okAsync<void, GithubCallError>(undefined);
      return closed.mapErr(callError).andThen(() => {
        const branch = pr.branch;
        // A branch that stays is reported on the activity; the pull request is closed either way.
        const deletion: ResultAsync<string | null, never> = branch
          ? github
              .deleteBranch(pr.repo, branch, merge.baseRef || undefined)
              .map((): string | null => null)
              .orElse((error) => okAsync(error.message))
          : okAsync(null);
        return deletion.andThen((branchError) => {
          const deleted = !!branch && branchError === null;
          const outcome: FactoryCloseOutcome = {
            kind: wasOpen ? 'closed' : 'already-closed',
            branchDeleted: deleted,
          };
          return ResultAsync.fromSafePromise(
            recordFactoryClose(
              activities,
              pr,
              by,
              { closed: wasOpen, branchError, deleted },
              origin,
            ),
          ).map(() => outcome);
        });
      });
    });
}

export function createFactoryPullRequests(deps: FactoryPullRequestsDeps): FactoryPullRequests {
  const activities = deps.activities ?? serverActivities;

  const recordMerge = (pr: FactoryPullRequestRef, branchError: string | null, deleted: boolean) =>
    recordFactoryMerge(activities, pr, branchError, deleted);

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

  /** GitHub calls with a server-only token (`issuer`): one that writes checks or statuses only. */
  const serverOnlyGithub = (
    pr: FactoryPullRequestRef,
    issuer: (repo: string, ownerToken: string | null) => ResultAsync<RepoToken, IssueError>,
  ) =>
    createRepoGithub({
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
   *
   * A merge GitHub failed to answer (a 5xx) is tried again, but only after
   * reading the pull request: GitHub merges behind a 502 at times, and a
   * second merge of a merged pull request is a refusal.
   */
  const mergePinned = (
    pr: FactoryPullRequestRef,
    sha: string,
    method: MergeMethod,
    options: FactoryMergeOptions,
  ): ResultAsync<FactoryMergeOutcome, FactoryPullRequestError> =>
    retryTransientGithub(
      () =>
        createRepoCheckOps(repoGithubFor(pr, 'write')).pinnedMerge(pr.repo, pr.number, sha, method),
      {
        ...retryOptionsOf(deps, `merge of ${pr.repo}#${pr.number}`, options.signal),
        alreadyDone: () =>
          pullRequestsFor(pr, 'read')
            .mergeState(pr.repo, pr.number)
            .map((state) =>
              state.state === 'merged' ? { kind: 'merged' as const, method } : null,
            ),
      },
    )
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
    retarget: (pr, base) =>
      repoGithubFor(pr, 'write')
        .json(pr.repo, 'PATCH', `/repos/${pr.repo}/pulls/${pr.number}`, { base })
        .map(() => undefined)
        .mapErr((e): FactoryPullRequestError => ({ kind: 'github-error', message: e.message })),
    integrationFor: (owner) =>
      createGithubIntegration(repoGithubFor({ ...owner, repo: '', number: 0 }, 'write')),
    ciState(pr, required) {
      return pullRequestsFor(pr, 'read').ciState(pr.repo, pr.number, required).mapErr(callError);
    },

    prState(pr) {
      return pullRequestsFor(pr, 'read')
        .mergeState(pr.repo, pr.number)
        .map((merge) => merge.state)
        .mapErr(callError);
    },

    closeReplaced(pr, by, origin) {
      return closeReplacedPullRequest(pullRequestsFor(pr, 'write'), activities, pr, by, origin);
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

    changedFiles(pr) {
      return listPullRequestFiles(repoGithubFor(pr, 'read'), pr.repo, pr.number).mapErr(callError);
    },

    baseDistance(pr, baseRef, headSha) {
      return baseDistance(repoGithubFor(pr, 'read'), pr.repo, baseRef, headSha).mapErr(callError);
    },

    updateBranch(pr, headSha, signal) {
      // Safe to repeat: the request names the head it expects, so one that did
      // take effect behind an error is answered "head moved" the second time.
      return retryTransientGithub(
        () => updateBranch(repoGithubFor(pr, 'write'), pr.repo, pr.number, headSha),
        retryOptionsOf(deps, `update-branch of ${pr.repo}#${pr.number}`, signal),
      ).mapErr(callError);
    },

    commitParents(pr, sha) {
      return commitParents(repoGithubFor(pr, 'read'), pr.repo, sha).mapErr(callError);
    },

    baseChanges(pr, headSha, baseRef) {
      return baseChangesSince(repoGithubFor(pr, 'read'), pr.repo, headSha, baseRef).mapErr(
        callError,
      );
    },

    mergeQueueRequired(pr, baseRef) {
      return requiresMergeQueue(repoGithubFor(pr, 'read'), pr.repo, baseRef).mapErr(callError);
    },

    enqueue(pr, headSha) {
      const github = repoGithubFor(pr, 'write');
      return mergeQueueState(github, pr.repo, pr.number)
        .andThen((state) => enqueuePullRequest(github, pr.repo, state.id, headSha))
        .mapErr(callError);
    },

    queueState(pr) {
      return mergeQueueState(repoGithubFor(pr, 'read'), pr.repo, pr.number)
        .map((state) => state.kind)
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
      return createRepoCheckOps(serverOnlyGithub(pr, issuer))
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

    publishReview(pr, review) {
      const issuer = deps.issueStatusPublisher;
      const commented = review.body
        ? commentReview(repoGithubFor(pr, 'write'), pr.repo, pr.number, {
            commitId: review.sha,
            body: review.body,
          }).mapErr(callError)
        : okAsync<unknown, FactoryPullRequestError>(undefined);
      return commented.andThen(() => {
        if (!issuer) return okAsync({ status: false });
        return (
          setCommitStatus(serverOnlyGithub(pr, issuer), pr.repo, review.sha, {
            context: REVIEW_STATUS_CONTEXT,
            state: review.allowsMerge ? 'success' : 'failure',
            description: review.description,
          })
            .map(() => ({ status: true }))
            // The comment is on the pull request: a status GitHub refused is not an error.
            .orElse(() => okAsync({ status: false }))
        );
      });
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
              const branch = pr.branch;
              // Pull requests stacked on this one move to its base first (D10):
              // GitHub closes them when their base branch is deleted.
              return github
                .mergeState(pr.repo, pr.number)
                .andThen((merge) => github.deleteBranch(pr.repo, branch, merge.baseRef))
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
