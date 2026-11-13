/**
 * The PRs tab list in one GitHub GraphQL request.
 *
 * The REST path made 31 calls per page: `GET /pulls` and then one
 * `GET /commits/{sha}` per PR for its last commit (each answer carries the
 * whole diff). Measured on this repo: ~4 s + ~12 s and 2.7 MB. The GraphQL
 * request brings the same fields plus the last commit and the commit count in
 * ~1.3 s, ~100 KB and 1 rate-limit point.
 *
 * GraphQL pages by cursor: the response carries `nextCursor`, sent back as
 * `cursor` for the next page.
 */

import type { GitHubPR, PRCommit } from '@funny/shared';

import { githubGraphQL } from './helpers.js';

const PULL_REQUESTS_QUERY = `
  query PullRequestList(
    $owner: String!
    $repo: String!
    $first: Int!
    $after: String
    $states: [PullRequestState!]
    $field: IssueOrderField!
    $direction: OrderDirection!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequests(
        first: $first
        after: $after
        states: $states
        orderBy: { field: $field, direction: $direction }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          url
          isDraft
          createdAt
          updatedAt
          mergedAt
          author { login avatarUrl }
          headRefName
          headRefOid
          baseRefName
          headRepositoryOwner { login }
          labels(first: 20) { nodes { name color } }
          assignees(first: 10) { nodes { login avatarUrl } }
          reviewRequests(first: 10) {
            nodes { requestedReviewer { ... on User { login avatarUrl } } }
          }
          commits(last: 1) {
            totalCount
            nodes {
              commit {
                oid
                message
                committedDate
                author { name user { login avatarUrl } }
              }
            }
          }
        }
      }
    }
  }
`;

interface UserNode {
  login: string;
  avatarUrl: string;
}

interface PRNode {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  author: UserNode | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  headRepositoryOwner: { login: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> } | null;
  assignees: { nodes: UserNode[] } | null;
  reviewRequests: { nodes: Array<{ requestedReviewer: Partial<UserNode> | null }> } | null;
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: {
        oid: string;
        message: string;
        committedDate: string;
        author: { name: string | null; user: UserNode | null } | null;
      };
    }>;
  };
}

export interface PullRequestsData {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: PRNode[];
    };
  } | null;
}

/** REST `state` → GraphQL states. REST `closed` covers merged PRs too. */
export function prStates(state: 'open' | 'closed' | 'all'): string[] | null {
  if (state === 'open') return ['OPEN'];
  if (state === 'closed') return ['CLOSED', 'MERGED'];
  return null;
}

/**
 * The `/pulls` sort from `resolveSort` → GraphQL order. `popularity` (most
 * commented) becomes `COMMENTS`, GitHub's closest GraphQL equivalent.
 */
export function prOrder(sort: string, direction: string): { field: string; direction: string } {
  const field =
    sort === 'updated' ? 'UPDATED_AT' : sort === 'popularity' ? 'COMMENTS' : 'CREATED_AT';
  return { field, direction: direction === 'asc' ? 'ASC' : 'DESC' };
}

const user = (u: UserNode) => ({ login: u.login, avatar_url: u.avatarUrl });
const userOrNull = (u: UserNode | null | undefined) => (u ? user(u) : null);

/** Team review requests have no login; REST `requested_reviewers` lists users only. */
function requestedReviewers(pr: PRNode) {
  return (pr.reviewRequests?.nodes ?? [])
    .map((r) => r.requestedReviewer)
    .filter((r): r is UserNode => typeof r?.login === 'string')
    .map(user);
}

function lastCommit(pr: PRNode): PRCommit | null {
  const last = pr.commits.nodes[0]?.commit;
  if (!last) return null;
  return {
    sha: last.oid,
    message: last.message,
    author: userOrNull(last.author?.user),
    author_name: last.author?.name ?? null,
    date: last.committedDate,
  };
}

function refs(pr: PRNode, owner: string): Pick<GitHubPR, 'head' | 'base'> {
  const headOwner = pr.headRepositoryOwner?.login ?? owner;
  return {
    head: { ref: pr.headRefName, label: `${headOwner}:${pr.headRefName}`, sha: pr.headRefOid },
    base: { ref: pr.baseRefName, label: `${owner}:${pr.baseRefName}` },
  };
}

/** Maps one GraphQL PR to the REST shape the client already reads. */
function mapPullRequestNode(pr: PRNode, owner: string): GitHubPR {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || null,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    html_url: pr.url,
    user: userOrNull(pr.author),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    ...refs(pr, owner),
    draft: pr.isDraft,
    labels: pr.labels?.nodes ?? [],
    assignees: (pr.assignees?.nodes ?? []).map(user),
    requested_reviewers: requestedReviewers(pr),
    commits: pr.commits.totalCount,
    merged_at: pr.mergedAt,
    last_commit: lastCommit(pr),
  };
}

export function mapPullRequests(
  data: PullRequestsData,
  owner: string,
): { prs: GitHubPR[]; hasMore: boolean; nextCursor: string | null } {
  const connection = data.repository?.pullRequests;
  if (!connection) return { prs: [], hasMore: false, nextCursor: null };
  const { hasNextPage, endCursor } = connection.pageInfo;
  return {
    prs: connection.nodes.map((pr) => mapPullRequestNode(pr, owner)),
    hasMore: hasNextPage,
    nextCursor: hasNextPage ? endCursor : null,
  };
}

export async function fetchPullRequests(
  owner: string,
  repo: string,
  opts: {
    state: 'open' | 'closed' | 'all';
    sort: string;
    direction: string;
    perPage: number;
    cursor: string | null;
    token: string;
  },
): Promise<{ prs: GitHubPR[]; hasMore: boolean; nextCursor: string | null }> {
  const order = prOrder(opts.sort, opts.direction);
  const data = await githubGraphQL<PullRequestsData>(
    PULL_REQUESTS_QUERY,
    {
      owner,
      repo,
      first: opts.perPage,
      after: opts.cursor,
      states: prStates(opts.state),
      field: order.field,
      direction: order.direction,
    },
    opts.token,
  );
  return mapPullRequests(data, owner);
}
