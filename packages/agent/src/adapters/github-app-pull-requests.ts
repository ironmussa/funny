/**
 * The CI of a factory run's pull request over GitHub's API, with the Factory
 * App's token: check runs and commit statuses of the head commit, the pull
 * request's mergeability, the end of a failed GitHub Actions job's log, and
 * GraphQL's `markPullRequestReadyForReview` (REST cannot take a PR out of draft).
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { IssueSourceError } from '../ports/issue-source.js';
import type { CiState, PullRequestCi } from '../ports/pull-request-ci.js';
import type { FailingCheck } from '../steps/fix.js';
import type { FactoryAppTokens } from './factory-app.js';
import { createFactoryGithub, type FactoryGithub } from './factory-github.js';

interface RestPull {
  node_id: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  head: { sha: string };
}

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
        .andThen((pr) =>
          github.json<{ errors?: Array<{ message: string }> }>(repo, 'POST', '/graphql', {
            query: mutation,
            variables: { id: pr.node_id },
          }),
        )
        .andThen((answer) =>
          answer.errors?.length
            ? errAsync({ message: `GitHub refused to mark it ready: ${answer.errors[0].message}` })
            : okAsync(undefined),
        );
    },
  };
}
