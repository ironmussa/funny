/**
 * The CI of a factory run's pull request over GitHub's API, with the Factory
 * App's token: check runs and commit statuses of the head commit, the pull
 * request's mergeability, the end of a failed GitHub Actions job's log, and
 * GraphQL's `markPullRequestReadyForReview` (REST cannot take a PR out of draft).
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { IssueSourceError } from '../ports/issue-source.js';
import type {
  AutoMergeResult,
  CiState,
  MergeMethod,
  MergeState,
  PullRequestCi,
} from '../ports/pull-request-ci.js';
import type { FailingCheck } from '../steps/fix.js';
import type { FactoryAppTokens } from './factory-app.js';
import { createFactoryGithub, type FactoryGithub } from './factory-github.js';

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
function excerptOf(github: FactoryGithub, repo: string, run: RestCheckRun) {
  if (run.app?.slug !== 'github-actions') return okAsync(tail(checkSummary(run)));
  return github
    .text(repo, `/repos/${repo}/actions/jobs/${run.id}/logs`)
    .map(tail)
    .orElse(() => okAsync(tail(checkSummary(run))));
}

export function createGithubAppPullRequests(deps: {
  tokens: FactoryAppTokens;
  fetch?: typeof fetch;
  api?: string;
}): PullRequestCi {
  const github = createFactoryGithub(deps);

  const failingChecks = (
    repo: string,
    runs: RestCheckRun[],
    status: RestCombinedStatus,
  ): ResultAsync<FailingCheck[], IssueSourceError> => {
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

  const stateOfCommit = (repo: string, sha: string): ResultAsync<CiState, IssueSourceError> =>
    github
      .json<{ check_runs: RestCheckRun[] }>(
        repo,
        'GET',
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      )
      .andThen((checks) =>
        github
          .json<RestCombinedStatus>(repo, 'GET', `/repos/${repo}/commits/${sha}/status`)
          .andThen((status): ResultAsync<CiState, IssueSourceError> => {
            const runs = checks.check_runs;
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
    ciState(repo, number) {
      return pull(repo, number).andThen((pr) =>
        pr.mergeable === false || pr.mergeable_state === 'dirty'
          ? okAsync<CiState, IssueSourceError>({ kind: 'conflict' })
          : stateOfCommit(repo, pr.head.sha),
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

    enableAutoMerge(repo, number) {
      return github.json<RestRepo>(repo, 'GET', `/repos/${repo}`).andThen((settings) => {
        if (settings.allow_auto_merge === false) {
          return okAsync(unavailable(AUTO_MERGE_NOT_ALLOWED));
        }
        // The settings GitHub shows say which methods are allowed; when it shows
        // none, every method is tried in order and GitHub decides.
        const known = MERGE_METHODS.some(([, setting]) => settings[setting] !== undefined);
        const methods = MERGE_METHODS.filter(([, setting]) => !known || settings[setting]).map(
          ([method]) => method,
        );
        if (methods.length === 0)
          return okAsync(unavailable('the repository allows no merge method'));
        return pull(repo, number).andThen((pr) => tryMethods(repo, number, pr, methods));
      });
    },

    mergeState(repo, number) {
      return pull(repo, number).map((pr): MergeState => ({
        state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        autoMerge: !!pr.auto_merge,
      }));
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
  ): ResultAsync<AutoMergeResult, IssueSourceError> {
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
  ): ResultAsync<AutoMergeResult | { kind: 'method-refused' }, IssueSourceError> {
    if (!error) return okAsync({ kind: 'enabled', method });
    if (/clean status/i.test(error)) return mergeNow(repo, number, pr.head.sha, method);
    if (/auto.?merge is not allowed/i.test(error))
      return okAsync(unavailable(AUTO_MERGE_NOT_ALLOWED));
    if (/merge method|not allowed/i.test(error)) return okAsync({ kind: 'method-refused' });
    return errAsync({ message: `GitHub refused to enable auto-merge: ${error}` });
  }

  /** Merge now, only if the head is still the commit whose CI was green. */
  function mergeNow(repo: string, number: number, sha: string, method: MergeMethod) {
    return github
      .json(repo, 'PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha })
      .map((): AutoMergeResult => ({ kind: 'merged', method }))
      .orElse((e) =>
        e.status === 405 || e.status === 409
          ? okAsync<AutoMergeResult, IssueSourceError>({ kind: 'not-mergeable', reason: e.message })
          : errAsync(e),
      );
  }
}

const AUTO_MERGE_NOT_ALLOWED = 'the repository does not allow auto-merge';

const ENABLE_AUTO_MERGE =
  'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number } } }';

const unavailable = (reason: string): AutoMergeResult => ({ kind: 'unavailable', reason });
