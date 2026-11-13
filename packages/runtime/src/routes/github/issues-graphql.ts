/**
 * One GitHub GraphQL request for the Issues panel: a page of issues, the PRs
 * GitHub links to each of them, and the repository's open PRs.
 *
 * It replaces three REST calls (issue search + `pulls?state=open` +
 * `pulls?state=closed`, 100 full PR objects each). The closed-PR list alone
 * was ~2.5 MB and 2–3 s and only fed the PR badges. Measured on this repo, the
 * GraphQL request takes ~0.8 s, weighs 10–35 KB and costs 1 rate-limit point.
 *
 * - `closedByPullRequestsReferences` is GitHub's own issue ↔ PR link (closing
 *   keywords in the PR description, or a manual link from the sidebar).
 * - The open PRs keep the branch-name link (`issue-42-fix` without `Fixes
 *   #42`) and the closing keyword in a PR title, both read by `linkIssues`.
 *
 * GraphQL search pages by cursor, not by page number: the response carries
 * `nextCursor` and the next request sends it back as `cursor`.
 */

import type { GitHubIssue } from '@funny/shared';

import { githubGraphQL } from './helpers.js';
import type { LinkablePR } from './issue-links.js';

const ISSUES_WITH_LINKS_QUERY = `
  query IssuesWithLinks($q: String!, $first: Int!, $after: String, $owner: String!, $repo: String!) {
    search(query: $q, type: ISSUE, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          number
          title
          url
          state
          body
          createdAt
          updatedAt
          comments { totalCount }
          author { login avatarUrl }
          labels(first: 10) { nodes { name color } }
          closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
            nodes { number url title state merged headRefName }
          }
        }
      }
    }
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 100, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { number url title state merged headRefName }
      }
    }
  }
`;

interface PRNode {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  headRefName: string;
}

interface IssueNode {
  number?: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  body: string | null;
  createdAt: string;
  updatedAt: string;
  comments: { totalCount: number };
  author: { login: string; avatarUrl: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> } | null;
  closedByPullRequestsReferences: { nodes: PRNode[] } | null;
}

export interface IssuesWithLinksData {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: IssueNode[];
  };
  repository: { pullRequests: { nodes: PRNode[] } } | null;
}

export interface IssuesWithLinks {
  issues: GitHubIssue[];
  pullRequests: LinkablePR[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** GitHub search syntax for one repository's issues, newest first. */
export function issueSearchQuery(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all',
): string {
  const stateQualifier = state === 'all' ? '' : ` state:${state}`;
  return `repo:${owner}/${repo} is:issue${stateQualifier} sort:created-desc`;
}

function toLinkablePR(pr: PRNode, closes: number[]): LinkablePR {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    merged: pr.merged,
    headRef: pr.headRefName,
    closes,
  };
}

/** Maps the GraphQL response to the REST issue shape the client already reads. */
export function mapIssuesWithLinks(data: IssuesWithLinksData): IssuesWithLinks {
  const prs = new Map<number, LinkablePR>();
  const addPR = (node: PRNode, closes: number[]) => {
    const known = prs.get(node.number);
    if (known) known.closes.push(...closes);
    else prs.set(node.number, toLinkablePR(node, [...closes]));
  };

  const issues: GitHubIssue[] = [];
  // Search can return an empty object for a node it cannot show (no number).
  for (const node of data.search.nodes) {
    if (typeof node.number !== 'number') continue;
    issues.push({
      number: node.number,
      title: node.title,
      state: node.state === 'OPEN' ? 'open' : 'closed',
      body: node.body || null,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      html_url: node.url,
      user: node.author ? { login: node.author.login, avatar_url: node.author.avatarUrl } : null,
      labels: node.labels?.nodes ?? [],
      comments: node.comments.totalCount,
    });
    for (const pr of node.closedByPullRequestsReferences?.nodes ?? []) addPR(pr, [node.number]);
  }
  for (const pr of data.repository?.pullRequests.nodes ?? []) addPR(pr, []);

  return {
    issues,
    pullRequests: [...prs.values()],
    hasMore: data.search.pageInfo.hasNextPage,
    nextCursor: data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null,
  };
}

export async function fetchIssuesWithLinks(
  owner: string,
  repo: string,
  opts: {
    state: 'open' | 'closed' | 'all';
    perPage: number;
    cursor: string | null;
    token: string;
  },
): Promise<IssuesWithLinks> {
  const data = await githubGraphQL<IssuesWithLinksData>(
    ISSUES_WITH_LINKS_QUERY,
    {
      q: issueSearchQuery(owner, repo, opts.state),
      first: opts.perPage,
      after: opts.cursor,
      owner,
      repo,
    },
    opts.token,
  );
  return mapIssuesWithLinks(data);
}
