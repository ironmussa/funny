/**
 * What the issue factory's merge queue does on the repository host (openspec
 * factory-integration D4): read the base branch's rules, build a batch on
 * temporary branches by merging pull request heads server-side (no checkout),
 * read the checks of a commit, merge a pull request pinned to the head that
 * was tested, and clean up. The queue only uses this interface; GitHub is the
 * one implementation (`createGithubIntegration`), over a repository-scoped
 * token the caller supplies. Nothing here bypasses a branch rule.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import { enqueuePullRequest, mergeQueueState, type EnqueueResult } from './merge-queue.js';
import { retargetPullRequestsOn } from './pull-request-base.js';
import type { CiState, MergeMethod, PullRequestCi } from './pull-requests.js';
import { createPullRequestCi } from './pull-requests.js';
import type { GithubCallError, RepoGithub } from './repo-github.js';

/** What the base branch's rules say about merging into it. */
export interface BranchRules {
  /** Every merge must go through the host's merge queue. */
  mergeQueue: boolean;
  /** The checks the rules require (rulesets); empty when none are known. */
  requiredChecks: string[];
  /**
   * Pull requests must be up to date with the branch before they merge
   * (`strict` status checks). Null when it cannot be read (classic branch
   * protection needs the administration permission the App does not have).
   */
  upToDate: boolean | null;
}

export type MergeRefResult =
  /** `ref` was merged into the branch, which now points at `sha`. */
  | { kind: 'merged'; sha: string }
  /** The branch already contains `ref`. */
  | { kind: 'up-to-date' }
  /** `ref` does not merge cleanly into the branch: nothing was written. */
  | { kind: 'conflict' };

export type MergePullRequestResult =
  | { kind: 'merged'; sha: string }
  /** The host refused (a rule, a head that moved, not mergeable): nothing merged. */
  | { kind: 'refused'; reason: string; status?: number };

/** Adding a pull request to the host's queue: queued (or already), merged or closed meanwhile, or refused. */
export type HostQueueResult = EnqueueResult | { kind: 'merged' } | { kind: 'closed' };

/** How the host sees a pull request's mergeability now. */
export interface PullRequestMergeability {
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  /** Null while the host is still computing it. */
  mergeable: boolean | null;
}

export interface IntegrationProvider {
  branchRules(repo: string, branch: string): ResultAsync<BranchRules, GithubCallError>;
  /** The commit a branch points at. */
  branchHead(repo: string, branch: string): ResultAsync<string, GithubCallError>;
  /** Point branch `name` at `sha`, creating it or moving it (a queue's own branch only). */
  setBranch(repo: string, name: string, sha: string): ResultAsync<void, GithubCallError>;
  /** Merge `ref` into `branch` on the host, with `message`. */
  mergeRefInto(
    repo: string,
    branch: string,
    ref: string,
    message: string,
  ): ResultAsync<MergeRefResult, GithubCallError>;
  /**
   * A new commit with `sha`'s tree and `sha` as its parent: the same files,
   * a new commit for CI to test (a message without `[skip ci]`, or a re-test).
   */
  sameTreeCommit(repo: string, sha: string, message: string): ResultAsync<string, GithubCallError>;
  /** The tree of commit `sha` (two commits with the same tree hold the same files). */
  treeOf(repo: string, sha: string): ResultAsync<string, GithubCallError>;
  /** The CI verdict of commit `sha`, counting only `required` when given. */
  checks(
    repo: string,
    sha: string,
    required?: readonly string[],
  ): ResultAsync<CiState, GithubCallError>;
  /** The names of the checks that reported on commit `sha`. */
  checkNames(repo: string, sha: string): ResultAsync<string[], GithubCallError>;
  /** Merge pull request `number`, only while its head is `sha`. */
  mergePullRequest(
    repo: string,
    number: number,
    input: { sha: string; method: MergeMethod },
  ): ResultAsync<MergePullRequestResult, GithubCallError>;
  pullRequestMergeability(
    repo: string,
    number: number,
  ): ResultAsync<PullRequestMergeability, GithubCallError>;
  /** Add the pull request to the host's merge queue, only while its head is `sha`. */
  enqueueInHostQueue(
    repo: string,
    number: number,
    sha: string,
  ): ResultAsync<HostQueueResult, GithubCallError>;
  /** Delete a branch; one already gone is not an error. */
  /**
   * Delete a branch; one already gone is fine. With `retargetTo`, the open
   * pull requests based on it move there first (the branch stays when they
   * cannot): GitHub closes them otherwise.
   */
  deleteBranch(
    repo: string,
    branch: string,
    retargetTo?: string,
  ): ResultAsync<void, GithubCallError>;
  /** The paths changed between commits `from` and `to` (at most 300, GitHub's compare). */
  changedPaths(repo: string, from: string, to: string): ResultAsync<string[], GithubCallError>;
}

/** A branch as path segments: `release/1.x` keeps its slashes. */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

interface RestRule {
  type: string;
  parameters?: {
    required_status_checks?: Array<{ context: string }>;
    strict_required_status_checks_policy?: boolean;
  };
}

const MERGE_QUEUE_FIELD = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } }
}`;

interface MergeQueueAnswer {
  data?: { repository?: { mergeQueue?: { id: string } | null } | null } | null;
  errors?: Array<{ message: string }>;
}

/** The rules of `branch`: none where the repository has no rules (404) or its plan has none (403). */
function rulesOf(github: RepoGithub, repo: string, branch: string) {
  return github
    .json<RestRule[]>(repo, 'GET', `/repos/${repo}/rules/branches/${refPath(branch)}?per_page=100`)
    .orElse((e) => (e.status === 404 || e.status === 403 ? okAsync<RestRule[]>([]) : errAsync(e)));
}

/**
 * Whether GitHub has a merge queue for `branch` (GraphQL, so classic branch
 * protection's queue is seen too, without the administration permission).
 * An answer GitHub refuses (a plan without merge queues) counts as none.
 */
function hasMergeQueue(github: RepoGithub, repo: string, branch: string) {
  const [owner, name] = repo.split('/');
  return github
    .json<MergeQueueAnswer>(repo, 'POST', '/graphql', {
      query: MERGE_QUEUE_FIELD,
      variables: { owner, name, branch },
    })
    .map((answer) => !!answer.data?.repository?.mergeQueue)
    .orElse(() => okAsync(false));
}

/** What the rulesets and the merge queue field say about merging into `branch`. */
export function readBranchRules(
  github: RepoGithub,
  repo: string,
  branch: string,
): ResultAsync<BranchRules, GithubCallError> {
  return rulesOf(github, repo, branch).andThen((rules) =>
    hasMergeQueue(github, repo, branch).map((queue): BranchRules => {
      const checks = rules.filter((rule) => rule.type === 'required_status_checks');
      return {
        mergeQueue: queue || rules.some((rule) => rule.type === 'merge_queue'),
        requiredChecks: [
          ...new Set(
            checks.flatMap((rule) =>
              (rule.parameters?.required_status_checks ?? []).map((c) => c.context),
            ),
          ),
        ],
        // A ruleset that requires checks says whether they must be up to date;
        // without one, classic protection may still require it, unreadable here.
        upToDate:
          checks.length > 0
            ? checks.some((rule) => rule.parameters?.strict_required_status_checks_policy === true)
            : null,
      };
    }),
  );
}

interface RestPullForMerge {
  state: string;
  merged?: boolean;
  mergeable: boolean | null;
  head: { sha: string };
}

const refusalReason = (e: GithubCallError) => e.detail ?? e.message;

export function createGithubIntegration(
  github: RepoGithub,
  ci: PullRequestCi = createPullRequestCi(github),
): IntegrationProvider {
  const commitOf = (repo: string, sha: string) =>
    github.json<{ sha: string; tree: { sha: string } }>(
      repo,
      'GET',
      `/repos/${repo}/git/commits/${sha}`,
    );

  return {
    branchRules: (repo, branch) => readBranchRules(github, repo, branch),

    branchHead(repo, branch) {
      return github
        .json<{ object: { sha: string } }>(
          repo,
          'GET',
          `/repos/${repo}/git/ref/heads/${refPath(branch)}`,
        )
        .map((ref) => ref.object.sha);
    },

    setBranch(repo, name, sha) {
      return github
        .json(repo, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha })
        .map(() => undefined)
        .orElse((e) =>
          // 422: the branch exists; move it (the queue's own branches only).
          e.status === 422
            ? github
                .json(repo, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(name)}`, {
                  sha,
                  force: true,
                })
                .map(() => undefined)
            : errAsync(e),
        );
    },

    mergeRefInto(repo, branch, ref, message) {
      return github
        .json<{ sha: string } | undefined>(repo, 'POST', `/repos/${repo}/merges`, {
          base: branch,
          head: ref,
          commit_message: message,
        })
        .map((merged): MergeRefResult =>
          // 204: nothing to merge.
          merged ? { kind: 'merged', sha: merged.sha } : { kind: 'up-to-date' },
        )
        .orElse((e) =>
          e.status === 409 ? okAsync<MergeRefResult>({ kind: 'conflict' }) : errAsync(e),
        );
    },

    sameTreeCommit(repo, sha, message) {
      return commitOf(repo, sha).andThen((commit) =>
        github
          .json<{ sha: string }>(repo, 'POST', `/repos/${repo}/git/commits`, {
            message,
            tree: commit.tree.sha,
            parents: [sha],
          })
          .map((created) => created.sha),
      );
    },

    treeOf: (repo, sha) => commitOf(repo, sha).map((commit) => commit.tree.sha),

    checks: (repo, sha, required) => ci.commitState(repo, sha, required),

    checkNames: (repo, sha) => ci.checkNames(repo, sha),

    mergePullRequest(repo, number, { sha, method }) {
      return github
        .json<{ merged?: boolean; sha?: string; message?: string }>(
          repo,
          'PUT',
          `/repos/${repo}/pulls/${number}/merge`,
          { sha, merge_method: method },
        )
        .map((answer): MergePullRequestResult =>
          answer?.merged && answer.sha
            ? { kind: 'merged', sha: answer.sha }
            : { kind: 'refused', reason: answer?.message ?? 'GitHub did not merge it' },
        )
        .orElse((e) =>
          // 405: not mergeable (a rule, a conflict); 409: the head is no longer `sha`.
          e.status === 405 || e.status === 409 || e.status === 422
            ? okAsync<MergePullRequestResult>({
                kind: 'refused',
                reason: refusalReason(e),
                status: e.status,
              })
            : errAsync(e),
        );
    },

    pullRequestMergeability(repo, number) {
      return github
        .json<RestPullForMerge>(repo, 'GET', `/repos/${repo}/pulls/${number}`)
        .map((pr): PullRequestMergeability => ({
          state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
          headSha: pr.head.sha,
          mergeable: pr.mergeable,
        }));
    },

    enqueueInHostQueue(repo, number, sha) {
      return mergeQueueState(github, repo, number).andThen(
        (state): ResultAsync<HostQueueResult, GithubCallError> => {
          if (state.kind === 'not-queued') return enqueuePullRequest(github, repo, state.id, sha);
          if (state.kind === 'queued') return okAsync({ kind: 'queued' });
          return okAsync({ kind: state.kind });
        },
      );
    },

    changedPaths(repo, from, to) {
      return github
        .json<{ files?: Array<{ filename: string }> }>(
          repo,
          'GET',
          `/repos/${repo}/compare/${from}...${to}`,
        )
        .map((compare) => (compare.files ?? []).map((file) => file.filename));
    },

    deleteBranch(repo, branch, retargetTo) {
      const moved = retargetTo
        ? retargetPullRequestsOn(github, repo, branch, retargetTo).map(() => undefined)
        : okAsync<void, GithubCallError>(undefined);
      // Only the deletion may find the branch already gone; a refused retarget keeps it.
      return moved.andThen(() =>
        github
          .json(repo, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(branch)}`)
          .map(() => undefined)
          .orElse((e) => (e.status === 404 || e.status === 422 ? okAsync(undefined) : errAsync(e))),
      );
    },
  };
}
