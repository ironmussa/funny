/**
 * The PR detail (summary card, CI tab) in one GitHub GraphQL request.
 *
 * The REST path made five calls in two rounds: the PR, its reviews and the
 * default branch's `HEAD` check runs (only a fallback, and not about this PR),
 * then the head commit's check runs and the head commit itself (with its whole
 * diff, for the last-commit line). Measured on this repo: ~1.45 s. The GraphQL
 * request is one round, ~1.1 s, ~10 KB and 1 rate-limit point.
 */

import type { CICheck, MergeableState, PRCommit, PRDetail, ReviewDecision } from '@funny/shared';

import { githubGraphQL } from './helpers.js';

const PR_DETAIL_QUERY = `
  query PullRequestDetail($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        body
        state
        isDraft
        merged
        mergeable
        url
        additions
        deletions
        changedFiles
        createdAt
        updatedAt
        author { login avatarUrl }
        headRefName
        headRefOid
        baseRefName
        reviews(last: 100) { nodes { state author { login } } }
        commits(last: 1) {
          totalCount
          nodes {
            commit {
              oid
              message
              committedDate
              author { name user { login avatarUrl } }
              checkSuites(first: 50) {
                nodes {
                  app { name }
                  checkRuns(first: 100) {
                    nodes { databaseId name status conclusion url startedAt completedAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface CheckRunNode {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface PRDetailNode {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  merged: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviews: { nodes: Array<{ state: string; author: { login: string } | null }> } | null;
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: {
        oid: string;
        message: string;
        committedDate: string;
        author: { name: string | null; user: { login: string; avatarUrl: string } | null } | null;
        checkSuites: {
          nodes: Array<{
            app: { name: string } | null;
            checkRuns: { nodes: CheckRunNode[] } | null;
          }>;
        } | null;
      };
    }>;
  };
}

export interface PRDetailData {
  repository: { pullRequest: PRDetailNode | null } | null;
}

/** Latest decisive review per author, then ranked; any review at all means "review required". */
export function deriveReviewDecision(
  reviews: Array<{ state: string; login: string }>,
): ReviewDecision {
  const latestByAuthor = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
      latestByAuthor.set(r.login, r.state);
    }
  }
  const states = [...latestByAuthor.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return reviews.length > 0 ? 'REVIEW_REQUIRED' : null;
}

/** GraphQL check status → the REST values the client reads (waiting/pending count as queued). */
function checkStatus(status: string): CICheck['status'] {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'IN_PROGRESS') return 'in_progress';
  return 'queued';
}

function mapCheckRun(run: CheckRunNode, appName: string | null): CICheck {
  return {
    id: run.databaseId,
    name: run.name,
    status: checkStatus(run.status),
    conclusion: (run.conclusion?.toLowerCase() ?? null) as CICheck['conclusion'],
    html_url: run.url,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    app_name: appName,
  };
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function tallyChecks(checks: CICheck[]) {
  const tally = { passed: 0, failed: 0, pending: 0 };
  for (const ck of checks) {
    if (ck.status !== 'completed') tally.pending++;
    else if (PASSING_CONCLUSIONS.has(ck.conclusion as string)) tally.passed++;
    else tally.failed++;
  }
  return tally;
}

function mergeableState(mergeable: PRDetailNode['mergeable']): MergeableState {
  if (mergeable === 'MERGEABLE') return 'mergeable';
  if (mergeable === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

/** Maps the GraphQL PR to the REST-era `PRDetail` the client reads; `null` when it does not exist. */
export function mapPRDetail(data: PRDetailData): PRDetail | null {
  const pr = data.repository?.pullRequest;
  if (!pr) return null;
  const head = pr.commits.nodes[0]?.commit;
  const checks = (head?.checkSuites?.nodes ?? []).flatMap((suite) =>
    (suite.checkRuns?.nodes ?? []).map((run) => mapCheckRun(run, suite.app?.name ?? null)),
  );
  const tally = tallyChecks(checks);
  const lastCommit: PRCommit | null = head
    ? {
        sha: head.oid,
        message: head.message,
        author: head.author?.user
          ? { login: head.author.user.login, avatar_url: head.author.user.avatarUrl }
          : null,
        author_name: head.author?.name ?? null,
        date: head.committedDate,
      }
    : null;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    draft: pr.isDraft,
    merged: pr.merged,
    mergeable_state: mergeableState(pr.mergeable),
    html_url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changedFiles,
    commits: pr.commits.totalCount,
    head: { ref: pr.headRefName, sha: pr.headRefOid },
    base: { ref: pr.baseRefName },
    user: pr.author ? { login: pr.author.login, avatar_url: pr.author.avatarUrl } : null,
    review_decision: deriveReviewDecision(
      (pr.reviews?.nodes ?? []).map((r) => ({ state: r.state, login: r.author?.login ?? '' })),
    ),
    checks,
    checks_passed: tally.passed,
    checks_failed: tally.failed,
    checks_pending: tally.pending,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    last_commit: lastCommit,
  };
}

export async function fetchPRDetail(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<PRDetail | null> {
  const data = await githubGraphQL<PRDetailData>(PR_DETAIL_QUERY, { owner, repo, number }, token);
  return mapPRDetail(data);
}
