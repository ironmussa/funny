/**
 * The Issues panel loads issues and their PRs with one GraphQL request
 * (`issues-graphql.ts`) instead of three REST calls, two of them full PR
 * lists. These tests pin the mapping to the REST shape the client reads and
 * the PR links handed to `linkIssues`.
 */
import { describe, expect, test } from 'vitest';

import { linkIssues } from '../../routes/github/issue-links.js';
import {
  type IssuesWithLinksData,
  issueSearchQuery,
  mapIssuesWithLinks,
} from '../../routes/github/issues-graphql.js';

type PR = NonNullable<IssuesWithLinksData['repository']>['pullRequests']['nodes'][number];

function prNode(number: number, overrides: Partial<PR> = {}): PR {
  return {
    number,
    url: `https://github.com/acme/widget/pull/${number}`,
    title: `PR ${number}`,
    state: 'OPEN',
    merged: false,
    headRefName: `feature-${number}x`,
    ...overrides,
  };
}

function issueNode(number: number, closedBy: PR[] = []) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/widget/issues/${number}`,
    state: 'OPEN' as const,
    body: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    comments: { totalCount: 3 },
    author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    closedByPullRequestsReferences: { nodes: closedBy },
  };
}

function data(
  issues: ReturnType<typeof issueNode>[],
  openPRs: PR[] = [],
  pageInfo = { hasNextPage: false, endCursor: 'Y3Vyc29yOjMw' },
): IssuesWithLinksData {
  return {
    search: { pageInfo, nodes: issues },
    repository: { pullRequests: { nodes: openPRs } },
  };
}

const link = (d: IssuesWithLinksData) => {
  const mapped = mapIssuesWithLinks(d);
  return linkIssues(mapped.issues, {
    branches: [],
    pullRequests: mapped.pullRequests,
    repo: 'acme/widget',
    suggestBranchName: (i) => `issue-${i.number}`,
  });
};

describe('issueSearchQuery', () => {
  test('limits to the repository, issues and the state, newest first', () => {
    expect(issueSearchQuery('acme', 'widget', 'open')).toBe(
      'repo:acme/widget is:issue state:open sort:created-desc',
    );
    expect(issueSearchQuery('acme', 'widget', 'all')).toBe(
      'repo:acme/widget is:issue sort:created-desc',
    );
  });
});

describe('mapIssuesWithLinks', () => {
  test('maps an issue to the REST shape the client reads', () => {
    const { issues } = mapIssuesWithLinks(data([issueNode(7)]));
    expect(issues).toEqual([
      {
        number: 7,
        title: 'Issue 7',
        state: 'open',
        body: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        html_url: 'https://github.com/acme/widget/issues/7',
        user: { login: 'octo', avatar_url: 'https://avatars/octo' },
        labels: [{ name: 'bug', color: 'd73a4a' }],
        comments: 3,
      },
    ]);
  });

  test('returns the next cursor only while there are more pages', () => {
    const more = mapIssuesWithLinks(data([], [], { hasNextPage: true, endCursor: 'abc' }));
    expect(more).toMatchObject({ hasMore: true, nextCursor: 'abc' });
    const last = mapIssuesWithLinks(data([], [], { hasNextPage: false, endCursor: 'abc' }));
    expect(last).toMatchObject({ hasMore: false, nextCursor: null });
  });

  test('skips search nodes that are not issues', () => {
    const d = data([issueNode(1)]);
    d.search.nodes.push({} as never);
    expect(mapIssuesWithLinks(d).issues.map((i) => i.number)).toEqual([1]);
  });

  test('links the PR GitHub records as closing the issue, merged included', () => {
    const [linked] = link(data([issueNode(9, [prNode(20, { state: 'MERGED', merged: true })])]));
    expect(linked.linkedPR).toEqual({
      number: 20,
      url: 'https://github.com/acme/widget/pull/20',
      state: 'merged',
    });
    expect(linked.linkedBranch).toBeNull();
  });

  test('links an open PR by its branch name without a closing keyword', () => {
    const [linked] = link(data([issueNode(42)], [prNode(50, { headRefName: 'issue-42-fix' })]));
    expect(linked.linkedPR?.number).toBe(50);
    expect(linked.linkedBranch).toBe('issue-42-fix');
  });

  test('merges a PR that closes several issues into one entry', () => {
    const shared = prNode(30);
    const { pullRequests } = mapIssuesWithLinks(
      data([issueNode(1, [shared]), issueNode(2, [shared])], [shared]),
    );
    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0].closes).toEqual([1, 2]);
  });
});
