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

import { retargetPullRequestsOn } from './pull-request-base.js';
import type { GithubCallError, GithubRequestBody, RepoGithub } from './repo-github.js';

/** A failed check and the end of its log (or its summary). */
export interface FailingCheck {
  name: string;
  /** GitHub's conclusion (`failure`, `timed_out`, …). */
  conclusion: string;
  excerpt: string;
  /** Where the check is on GitHub, when it reports one. */
  url?: string;
  /** The first job step that failed, for a GitHub Actions check. */
  failedStep?: string;
}

export type CiState =
  /** Checks still running (or not reported yet). */
  | { kind: 'pending' }
  /** Every check passed. */
  | { kind: 'green' }
  /** No check or status reported on the head commit (yet, or the repository has no CI). */
  | { kind: 'none' }
  /** At least one check failed; none is still running. `sha`: the commit checked. */
  | { kind: 'failing'; checks: FailingCheck[]; sha?: string }
  /**
   * Nothing failed in the code, but a check could not run: a commit status in
   * `error` (the CI service itself failed, e.g. "add a card") or a check run
   * waiting for someone (`action_required`). No code change fixes it.
   */
  | { kind: 'blocked'; checks: FailingCheck[] }
  /** The pull request conflicts with its base. */
  | { kind: 'conflict' };

/** How the pull request stands for merging. */
export interface MergeState {
  state: 'open' | 'merged' | 'closed';
  /** Whether GitHub's auto-merge is enabled on it (a push or a person may turn it off). */
  autoMerge: boolean;
  /** The commit at the head of the pull request now. */
  headSha: string;
  /** The branch it merges into. */
  baseRef: string;
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
  /**
   * The CI verdict of a commit, branch or tag (never `conflict`): the state of
   * a base branch after merges, with the commit it is at.
   */
  refState(repo: string, ref: string): ResultAsync<{ sha: string; ci: CiState }, GithubCallError>;
  /**
   * The CI verdict of commit `sha`. With `required`, only those checks (or
   * commit statuses) count, and one not reported yet is pending.
   */
  commitState(
    repo: string,
    sha: string,
    required?: readonly string[],
  ): ResultAsync<CiState, GithubCallError>;
  /** The names of the checks and commit statuses that reported on commit `sha`. */
  checkNames(repo: string, sha: string): ResultAsync<string[], GithubCallError>;
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
    /** Only when this is still the head: a push since the caller looked enables nothing. */
    expectedHeadSha?: string,
  ): ResultAsync<AutoMergeResult, GithubCallError>;
  mergeState(repo: string, number: number): ResultAsync<MergeState, GithubCallError>;
  /** The URL of the open pull request from `branch`, or null when there is none. */
  findOpen(repo: string, branch: string): ResultAsync<string | null, GithubCallError>;
  /** Comment on the pull request. */
  comment(repo: string, number: number, body: string): ResultAsync<void, GithubCallError>;
  /** Close the pull request without merging it; one already closed stays closed. */
  close(repo: string, number: number): ResultAsync<void, GithubCallError>;
  /**
   * Delete a branch on GitHub; a branch already gone is not an error. With
   * `retargetTo`, the open pull requests based on it move there first (the
   * branch stays when they cannot).
   */
  deleteBranch(
    repo: string,
    branch: string,
    retargetTo?: string,
  ): ResultAsync<void, GithubCallError>;
}

interface RestPull {
  node_id: string;
  state?: string;
  merged?: boolean;
  auto_merge?: unknown;
  mergeable: boolean | null;
  mergeable_state?: string;
  head: { sha: string };
  base?: { ref: string };
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
  html_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
}

interface RestCombinedStatus {
  statuses: Array<{
    context: string;
    state: string;
    description: string | null;
    target_url?: string | null;
  }>;
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);
/** A check run that waits for a person, not for a code change. */
const BLOCKED_CONCLUSIONS = new Set(['action_required']);
/** A commit status whose CI service itself failed to run. */
const BLOCKED_STATUS_STATES = new Set(['error']);
/** How many failing checks, and how much of each log, reach the agent. */
const MAX_CHECKS = 5;
const MAX_EXCERPT = 4_000;

const tail = (text: string) => (text.length > MAX_EXCERPT ? `…${text.slice(-MAX_EXCERPT)}` : text);

function checkSummary(run: RestCheckRun): string {
  const out = run.output;
  return [out?.title, out?.summary, out?.text].filter(Boolean).join('\n\n') || '(no details)';
}

/** Lines of a job's log kept after its last `##[error]` line (what failed, not the cleanup after). */
const LINES_AFTER_ERROR = 3;
/** Around each failure marker: a few lines before it, and its message and stack after. */
const MARKER_BEFORE = 3;
const MARKER_AFTER = 30;
const MAX_MARKERS = 3;
/** Lines kept from the end of the failing step (the runner's summary). */
const END_LINES = 15;
// eslint-disable-next-line no-control-regex -- ANSI color codes in CI logs
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
/** A test that passed or was skipped: the bulk of a test log, and never why it failed. */
const PASSED_LINE = /^\s*(\((pass|skip|todo)\)|✓ )/;
/** Where a test runner says what failed (bun, jest / vitest, mocha, pytest, go). */
const FAILURE_MARKER =
  /^\s*(\(fail\)|# Unhandled error|FAIL\b|✗|✖|×|\d+\) |_{3,} .* _{3,}$|--- FAIL:|panic:)/;

/**
 * The part of a GitHub Actions job's log that says why it failed. The steps
 * after a failure (post-job cleanup) and the list of passing tests push the
 * error out of a plain tail, so: the log up to a few lines after its last
 * `##[error]` line, without passing and skipped tests, timestamps or color
 * codes; then the first failure markers with their message, and the end of
 * the failing step. A log without markers keeps its end.
 */
export function excerptOfJobLog(log: string): string {
  const all = log
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, '').replace(ANSI, ''))
    .filter((line) => !PASSED_LINE.test(line));
  let lastError = all.length - 1;
  while (lastError >= 0 && !all[lastError]!.includes('##[error]')) lastError -= 1;
  const lines = lastError === -1 ? all : all.slice(0, lastError + 1 + LINES_AFTER_ERROR);
  const markers = lines.flatMap((line, index) => (FAILURE_MARKER.test(line) ? [index] : []));
  const endFrom = Math.max(0, lines.length - END_LINES);
  if (markers.length === 0 || markers[0]! >= endFrom - MARKER_BEFORE) {
    return tail(lines.join('\n').trimEnd());
  }
  // The windows around the first markers, merged where they overlap.
  const windows: Array<[number, number]> = [];
  for (const at of markers.slice(0, MAX_MARKERS)) {
    const from = Math.max(0, at - MARKER_BEFORE);
    const to = Math.min(endFrom, at + MARKER_AFTER);
    const last = windows.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else if (from < to) windows.push([from, to]);
  }
  const failures = windows.map(([from, to]) => lines.slice(from, to).join('\n')).join('\n…\n');
  // The end gets at most a third of the room; the failures, what is left.
  const ending = lines
    .slice(endFrom)
    .join('\n')
    .trimEnd()
    .slice(-Math.floor(MAX_EXCERPT / 3));
  const room = MAX_EXCERPT - ending.length;
  const head = failures.length > room ? `${failures.slice(0, room)}…` : failures;
  return `${head}\n…\n${ending}`;
}

/** Why a GitHub Actions job failed, from its log; else what the check reported. */
function excerptOf(github: RepoGithub, repo: string, run: RestCheckRun) {
  if (run.app?.slug !== 'github-actions') return okAsync(tail(checkSummary(run)));
  return github
    .text(repo, `/repos/${repo}/actions/jobs/${run.id}/logs`)
    .map(excerptOfJobLog)
    .orElse(() => okAsync(tail(checkSummary(run))));
}

/** The first step of a GitHub Actions job that failed; none for another check, or unreadable. */
function failedStepOf(github: RepoGithub, repo: string, run: RestCheckRun) {
  if (run.app?.slug !== 'github-actions') return okAsync<string | undefined, never>(undefined);
  return github
    .json<{ steps?: Array<{ name: string; conclusion: string | null }> }>(
      repo,
      'GET',
      `/repos/${repo}/actions/jobs/${run.id}`,
    )
    .map((job) => job.steps?.find((step) => step.conclusion === 'failure')?.name)
    .orElse(() => okAsync<string | undefined, never>(undefined));
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

const isBlocked = (check: FailingCheck) =>
  BLOCKED_CONCLUSIONS.has(check.conclusion) || BLOCKED_STATUS_STATES.has(check.conclusion);

/**
 * Failed checks become `failing` when one of them is the code's (only those,
 * so a fix step is not asked to fix a CI service), else `blocked`.
 */
function verdictOfFailures(failing: FailingCheck[], sha: string): CiState {
  if (failing.length === 0) return { kind: 'green' };
  const fixable = failing.filter((check) => !isBlocked(check));
  return fixable.length > 0
    ? { kind: 'failing', checks: fixable, sha }
    : { kind: 'blocked', checks: failing };
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
      .map((s): FailingCheck => {
        const check: FailingCheck = {
          name: s.context,
          conclusion: s.state,
          excerpt: s.description ?? '(no details)',
        };
        if (s.target_url) check.url = s.target_url;
        return check;
      });
    const fromRuns = failedRuns.slice(0, MAX_CHECKS).map((run) =>
      ResultAsync.combine([excerptOf(github, repo, run), failedStepOf(github, repo, run)]).map(
        ([excerpt, failedStep]): FailingCheck => {
          const check: FailingCheck = { name: run.name, conclusion: run.conclusion!, excerpt };
          if (run.html_url) check.url = run.html_url;
          if (failedStep) check.failedStep = failedStep;
          return check;
        },
      ),
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
            return failingChecks(repo, runs, status).map((failing) =>
              verdictOfFailures(failing, sha),
            );
          }),
      );

  const pull = (repo: string, number: number) =>
    github.json<RestPull>(repo, 'GET', `/repos/${repo}/pulls/${number}`);

  return {
    commitState: stateOfCommit,

    checkNames(repo, sha) {
      return github
        .json<{ check_runs: RestCheckRun[] }>(
          repo,
          'GET',
          `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
        )
        .andThen((checks) =>
          github
            .json<RestCombinedStatus>(repo, 'GET', `/repos/${repo}/commits/${sha}/status`)
            .map((all) => [
              ...new Set([
                ...checks.check_runs.map((run) => run.name),
                ...all.statuses.map((status) => status.context),
              ]),
            ]),
        );
    },

    refState(repo, ref) {
      const path = ref.split('/').map(encodeURIComponent).join('/');
      return github
        .json<{ sha: string }>(repo, 'GET', `/repos/${repo}/commits/${path}`)
        .andThen((commit) =>
          stateOfCommit(repo, commit.sha).map((ci) => ({ sha: commit.sha, ci })),
        );
    },

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

    enableAutoMerge(repo, number, preferred, expectedHeadSha) {
      return github.json<RestRepo>(repo, 'GET', `/repos/${repo}`).andThen((settings) => {
        // The settings GitHub shows say which methods are allowed; when it shows
        // none, every method is tried in order and GitHub decides.
        const known = MERGE_METHODS.some(([, setting]) => settings[setting] !== undefined);
        const methods = preferredFirst(
          MERGE_METHODS.flatMap(([method, setting]) =>
            !known || settings[setting] ? [method] : [],
          ),
          preferred,
        );
        if (methods.length === 0)
          return okAsync(unavailable('the repository allows no merge method'));
        return pull(repo, number).andThen((pr) => {
          if (expectedHeadSha && pr.head.sha !== expectedHeadSha) return okAsync(headMoved());
          return settings.allow_auto_merge === false
            ? mergeWhenClean(repo, number, pr, methods[0])
            : tryMethods(repo, number, pr, methods);
        });
      });
    },

    mergeState(repo, number) {
      return pull(repo, number).map((pr): MergeState => ({
        state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        autoMerge: !!pr.auto_merge,
        headSha: pr.head.sha,
        baseRef: pr.base?.ref ?? '',
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

    close(repo, number) {
      return github
        .json(repo, 'PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' })
        .map(() => undefined);
    },

    deleteBranch(repo, branch, retargetTo) {
      const ref = `/repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      const moved = retargetTo
        ? retargetPullRequestsOn(github, repo, branch, retargetTo).map(() => undefined)
        : okAsync<void, GithubCallError>(undefined);
      // Only the deletion may find the branch already gone; a refused retarget keeps it.
      return moved.andThen(() =>
        github
          .json(repo, 'DELETE', ref)
          .map(() => undefined)
          .orElse((e) => (e.status === 404 || e.status === 422 ? okAsync(undefined) : errAsync(e))),
      );
    },
  };

  function graphql(repo: string, query: string, variables: GithubRequestBody) {
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
    // Pinned to the head just read: a push in between enables nothing.
    return graphql(repo, ENABLE_AUTO_MERGE, {
      id: pr.node_id,
      method: method.toUpperCase(),
      head: pr.head.sha,
    })
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
    if (/head (sha|oid)|expected head/i.test(error)) return okAsync(headMoved());
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
  'mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { number } } }';

/** The head is no longer the commit the caller read (or asked for): look again. */
const headMoved = (): AutoMergeResult => ({
  kind: 'not-mergeable',
  reason: 'the pull request head moved',
  refused: true,
});

const unavailable = (reason: string): AutoMergeResult => ({ kind: 'unavailable', reason });
