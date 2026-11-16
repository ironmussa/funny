/**
 * A pull request followed after it was opened: the CI of its head commit
 * (check runs and commit statuses, with the end of a failed GitHub Actions
 * job's log), its mergeability, taking it out of draft (GraphQL: REST cannot),
 * auto-merge or a merge once every requirement is met, comments and branch
 * deletion. Shared by the issue factory and the server's `wait_ci` / `merge`
 * workflow nodes; the caller supplies the repository-scoped token
 * (`createRepoGithub`). Nothing here bypasses branch protections.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { GithubCallError, RepoGithub } from './repo-github.js';

/** A failed check and the end of its log (or its summary). */
export interface FailingCheck {
  name: string;
  /** GitHub's conclusion (`failure`, `timed_out`, …). */
  conclusion: string;
  excerpt: string;
}

export type CiState =
  /** Checks still running (or not reported yet). */
  | { kind: 'pending' }
  /** Every check passed. */
  | { kind: 'green' }
  /** No check or status reported on the head commit (yet, or the repository has no CI). */
  | { kind: 'none' }
  /** At least one check failed; none is still running. */
  | { kind: 'failing'; checks: FailingCheck[] }
  /** The pull request conflicts with its base. */
  | { kind: 'conflict' };

/** How the pull request stands for merging. */
export interface MergeState {
  state: 'open' | 'merged' | 'closed';
  /** Whether GitHub's auto-merge is enabled on it (a push or a person may turn it off). */
  autoMerge: boolean;
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type AutoMergeResult =
  /** GitHub merges it once its requirements are met (reviews, checks). */
  | { kind: 'enabled'; method: MergeMethod }
  /** Its requirements were already met: merged at once, the same way. */
  | { kind: 'merged'; method: MergeMethod }
  /** The repository allows no merge method. */
  | { kind: 'unavailable'; reason: string }
  /** It met its requirements, then no longer did (a push, a new review rule): look again later. */
  | {
      kind: 'not-mergeable';
      reason: string;
      /** GitHub refused the merge just now: the pull request's state is changing, look again soon. */
      refused?: boolean;
    };

export interface PullRequestCi {
  /**
   * The CI verdict of the pull request's head. With `required`, only the
   * checks (or commit statuses) of those names count, and one not reported
   * yet is pending.
   */
  ciState(
    repo: string,
    number: number,
    required?: readonly string[],
  ): ResultAsync<CiState, GithubCallError>;
  /** Take the pull request out of draft. */
  markReady(repo: string, number: number): ResultAsync<void, GithubCallError>;
  /**
   * Enable GitHub's auto-merge, with `preferred` (else squash) when the
   * repository allows it, else another allowed method. Never bypasses branch
   * protections.
   */
  enableAutoMerge(
    repo: string,
    number: number,
    preferred?: MergeMethod,
  ): ResultAsync<AutoMergeResult, GithubCallError>;
  mergeState(repo: string, number: number): ResultAsync<MergeState, GithubCallError>;
  /** The URL of the open pull request from `branch`, or null when there is none. */
  findOpen(repo: string, branch: string): ResultAsync<string | null, GithubCallError>;
  /** Comment on the pull request. */
  comment(repo: string, number: number, body: string): ResultAsync<void, GithubCallError>;
  /** Delete a branch on GitHub; a branch already gone is not an error. */
  deleteBranch(repo: string, branch: string): ResultAsync<void, GithubCallError>;
}

interface RestPull {
  node_id: string;
  state?: string;
  merged?: boolean;
  auto_merge?: unknown;
  mergeable: boolean | null;
  mergeable_state?: string;
  head: { sha: string };
}

interface RestRepo {
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  allow_auto_merge?: boolean;
}

/** Merge methods in the factory's order of preference, with the setting that allows each. */
const MERGE_METHODS: Array<[MergeMethod, keyof RestRepo]> = [
  ['squash', 'allow_squash_merge'],
  ['merge', 'allow_merge_commit'],
  ['rebase', 'allow_rebase_merge'],
];

type GraphqlAnswer = { errors?: Array<{ message: string }> };

interface RestCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
}

interface RestCombinedStatus {
  statuses: Array<{ context: string; state: string; description: string | null }>;
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);
/** How many failing checks, and how much of each log, reach the agent. */
const MAX_CHECKS = 5;
const MAX_EXCERPT = 4_000;

const tail = (text: string) => (text.length > MAX_EXCERPT ? `…${text.slice(-MAX_EXCERPT)}` : text);

function checkSummary(run: RestCheckRun): string {
  const out = run.output;
  return [out?.title, out?.summary, out?.text].filter(Boolean).join('\n\n') || '(no details)';
}

/** The end of a GitHub Actions job's log, else what the check reported. */
function excerptOf(github: RepoGithub, repo: string, run: RestCheckRun) {
  if (run.app?.slug !== 'github-actions') return okAsync(tail(checkSummary(run)));
  return github
    .text(repo, `/repos/${repo}/actions/jobs/${run.id}/logs`)
    .map(tail)
    .orElse(() => okAsync(tail(checkSummary(run))));
}

const anyFailed = (runs: RestCheckRun[], status: RestCombinedStatus) =>
  runs.some((run) => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) ||
  status.statuses.some((s) => s.state === 'failure' || s.state === 'error');

/**
 * The check runs and statuses that count: all of them, or only the `required`
 * names — then `missing` says whether one of those has not reported yet.
 */
function onlyRequired(
  runs: RestCheckRun[],
  status: RestCombinedStatus,
  required?: readonly string[],
): { runs: RestCheckRun[]; status: RestCombinedStatus; missing: boolean } {
  if (!required?.length) return { runs, status, missing: false };
  const wanted = new Set(required);
  const keptRuns = runs.filter((run) => wanted.has(run.name));
  const keptStatuses = status.statuses.filter((s) => wanted.has(s.context));
  const reported = new Set([...keptRuns.map((r) => r.name), ...keptStatuses.map((s) => s.context)]);
  return {
    runs: keptRuns,
    status: { statuses: keptStatuses },
    missing: required.some((name) => !reported.has(name)),
  };
}

export function createPullRequestCi(github: RepoGithub): PullRequestCi {
  const failingChecks = (
    repo: string,
    runs: RestCheckRun[],
    status: RestCombinedStatus,
  ): ResultAsync<FailingCheck[], GithubCallError> => {
    const failedRuns = runs.filter((r) => r.conclusion && FAILED_CONCLUSIONS.has(r.conclusion));
    const failedStatuses: FailingCheck[] = status.statuses
      .filter((s) => s.state === 'failure' || s.state === 'error')
      .map((s) => ({
        name: s.context,
        conclusion: s.state,
        excerpt: s.description ?? '(no details)',
      }));
    const fromRuns = failedRuns.slice(0, MAX_CHECKS).map((run) =>
      excerptOf(github, repo, run).map((excerpt): FailingCheck => ({
        name: run.name,
        conclusion: run.conclusion!,
        excerpt,
      })),
    );
    return ResultAsync.combine(fromRuns).map((checks) =>
      [...checks, ...failedStatuses].slice(0, MAX_CHECKS),
    );
  };

  const stateOfCommit = (
    repo: string,
    sha: string,
    required?: readonly string[],
  ): ResultAsync<CiState, GithubCallError> =>
    github
      .json<{ check_runs: RestCheckRun[] }>(
        repo,
        'GET',
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      )
      .andThen((checks) =>
        github
          .json<RestCombinedStatus>(repo, 'GET', `/repos/${repo}/commits/${sha}/status`)
          .andThen((all): ResultAsync<CiState, GithubCallError> => {
            const { runs, status, missing } = onlyRequired(checks.check_runs, all, required);
            // A required check that already failed is red even while another
            // required one has not reported: the fix loop should not wait on it.
            if (missing && !anyFailed(runs, status)) return okAsync({ kind: 'pending' });
            if (runs.length === 0 && status.statuses.length === 0) return okAsync({ kind: 'none' });
            const pending =
              runs.some((r) => r.status !== 'completed') ||
              status.statuses.some((s) => s.state === 'pending');
            if (pending) return okAsync({ kind: 'pending' });
            return failingChecks(repo, runs, status).map((failing): CiState =>
              failing.length > 0 ? { kind: 'failing', checks: failing } : { kind: 'green' },
            );
          }),
      );

  const pull = (repo: string, number: number) =>
    github.json<RestPull>(repo, 'GET', `/repos/${repo}/pulls/${number}`);

  return {
    ciState(repo, number, required) {
      return pull(repo, number).andThen((pr) =>
        pr.mergeable === false || pr.mergeable_state === 'dirty'
          ? okAsync<CiState, GithubCallError>({ kind: 'conflict' })
          : stateOfCommit(repo, pr.head.sha, required),
      );
    },
    markReady(repo, number) {
      const mutation =
        'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
      return pull(repo, number)
        .andThen((pr) => graphql(repo, mutation, { id: pr.node_id }))
        .andThen((answer) =>
          answer.errors?.length
            ? errAsync({ message: `GitHub refused to mark it ready: ${answer.errors[0].message}` })
            : okAsync(undefined),
        );
    },

    enableAutoMerge(repo, number, preferred) {
      return github.json<RestRepo>(repo, 'GET', `/repos/${repo}`).andThen((settings) => {
        // The settings GitHub shows say which methods are allowed; when it shows
        // none, every method is tried in order and GitHub decides.
        const known = MERGE_METHODS.some(([, setting]) => settings[setting] !== undefined);
        const methods = preferredFirst(
          MERGE_METHODS.filter(([, setting]) => !known || settings[setting]).map(
            ([method]) => method,
          ),
          preferred,
        );
        if (methods.length === 0)
          return okAsync(unavailable('the repository allows no merge method'));
        return pull(repo, number).andThen((pr) =>
          settings.allow_auto_merge === false
            ? mergeWhenClean(repo, number, pr, methods[0])
            : tryMethods(repo, number, pr, methods),
        );
      });
    },

    mergeState(repo, number) {
      return pull(repo, number).map((pr): MergeState => ({
        state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        autoMerge: !!pr.auto_merge,
      }));
    },

    findOpen(repo, branch) {
      const owner = repo.split('/')[0];
      const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' });
      return github
        .json<Array<{ html_url: string }>>(repo, 'GET', `/repos/${repo}/pulls?${query}`)
        .map((pulls) => pulls[0]?.html_url ?? null);
    },

    comment(repo, number, body) {
      // GitHub takes a pull request's comments through the issues API.
      return github
        .json(repo, 'POST', `/repos/${repo}/issues/${number}/comments`, { body })
        .map(() => undefined);
    },

    deleteBranch(repo, branch) {
      const ref = `/repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      return github
        .json(repo, 'DELETE', ref)
        .map(() => undefined)
        .orElse((e) => (e.status === 404 || e.status === 422 ? okAsync(undefined) : errAsync(e)));
    },
  };

  function graphql(repo: string, query: string, variables: Record<string, unknown>) {
    return github.json<GraphqlAnswer>(repo, 'POST', '/graphql', { query, variables });
  }

  /** Enable auto-merge with the first method GitHub accepts. */
  function tryMethods(
    repo: string,
    number: number,
    pr: RestPull,
    methods: MergeMethod[],
  ): ResultAsync<AutoMergeResult, GithubCallError> {
    const [method, ...rest] = methods;
    return graphql(repo, ENABLE_AUTO_MERGE, { id: pr.node_id, method: method.toUpperCase() })
      .andThen((answer) => afterEnable(repo, number, pr, method, answer.errors?.[0]?.message))
      .andThen((result) =>
        result.kind === 'method-refused' && rest.length > 0
          ? tryMethods(repo, number, pr, rest)
          : okAsync(
              result.kind === 'method-refused'
                ? unavailable('the repository allows no merge method')
                : result,
            ),
      );
  }

  /**
   * What enabling auto-merge left: enabled, or, when GitHub says the pull
   * request already meets every requirement ("clean status"), a merge now, the
   * same way and of the head commit that was green. Both go through branch
   * protections.
   */
  function afterEnable(
    repo: string,
    number: number,
    pr: RestPull,
    method: MergeMethod,
    error: string | undefined,
  ): ResultAsync<AutoMergeResult | { kind: 'method-refused' }, GithubCallError> {
    if (!error) return okAsync({ kind: 'enabled', method });
    if (/clean status/i.test(error)) return mergeNow(repo, number, pr.head.sha, method);
    if (/auto.?merge is not allowed/i.test(error)) return mergeWhenClean(repo, number, pr, method);
    if (/merge method|not allowed/i.test(error)) return okAsync({ kind: 'method-refused' });
    return errAsync({ message: `GitHub refused to enable auto-merge: ${error}` });
  }

  /**
   * Without GitHub's auto-merge (a private repository on GitHub Free, or the
   * setting off), the factory does its job: it merges once GitHub reports every
   * requirement met (`clean`), and looks again later otherwise. The merge itself
   * still goes through branch protections.
   */
  function mergeWhenClean(repo: string, number: number, pr: RestPull, method: MergeMethod) {
    return MERGEABLE_STATES.has(pr.mergeable_state ?? '')
      ? mergeNow(repo, number, pr.head.sha, method)
      : okAsync<AutoMergeResult, GithubCallError>({
          kind: 'not-mergeable',
          reason: `${AUTO_MERGE_NOT_ALLOWED}, so the factory merges it once GitHub reports every requirement met (now: ${pr.mergeable_state ?? 'unknown'})`,
        });
  }

  /** Merge now, only if the head is still the commit whose CI was green. */
  function mergeNow(repo: string, number: number, sha: string, method: MergeMethod) {
    return github
      .json(repo, 'PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha })
      .map((): AutoMergeResult => ({ kind: 'merged', method }))
      .orElse((e) =>
        e.status === 405 || e.status === 409
          ? okAsync<AutoMergeResult, GithubCallError>({
              kind: 'not-mergeable',
              reason: e.message,
              refused: true,
            })
          : errAsync(e),
      );
  }
}

/** `methods` with `preferred` moved first, when the repository allows it. */
function preferredFirst(methods: MergeMethod[], preferred: MergeMethod | undefined): MergeMethod[] {
  if (!preferred || !methods.includes(preferred)) return methods;
  return [preferred, ...methods.filter((method) => method !== preferred)];
}

const AUTO_MERGE_NOT_ALLOWED = 'the repository does not allow auto-merge';

/** `mergeable_state`s in which GitHub reports every requirement met. */
const MERGEABLE_STATES = new Set(['clean', 'has_hooks']);

const ENABLE_AUTO_MERGE =
  'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number } } }';

const unavailable = (reason: string): AutoMergeResult => ({ kind: 'unavailable', reason });
