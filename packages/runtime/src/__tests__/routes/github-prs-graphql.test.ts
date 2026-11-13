/**
 * The PRs tab list used to make one REST call for the page and one more per
 * PR for its last commit (31 calls, ~16 s on this repo). It is now one GraphQL
 * request; these tests pin its mapping to the REST shape the client reads.
 */
import { describe, expect, test } from 'vitest';

import {
  mapPullRequests,
  prOrder,
  prStates,
  type PullRequestsData,
} from '../../routes/github/prs-graphql.js';

type PRNode = NonNullable<PullRequestsData['repository']>['pullRequests']['nodes'][number];

function prNode(overrides: Partial<PRNode> = {}): PRNode {
  return {
    number: 12,
    title: 'Add thing',
    body: '',
    state: 'MERGED',
    url: 'https://github.com/acme/widget/pull/12',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    mergedAt: '2026-01-03T00:00:00Z',
    author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
    headRefName: 'feature',
    headRefOid: 'abc123',
    baseRefName: 'master',
    headRepositoryOwner: { login: 'fork-owner' },
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    assignees: { nodes: [{ login: 'ann', avatarUrl: 'https://avatars/ann' }] },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { login: 'rev', avatarUrl: 'https://avatars/rev' } },
        // A team request has no login.
        { requestedReviewer: {} },
      ],
    },
    commits: {
      totalCount: 4,
      nodes: [
        {
          commit: {
            oid: 'abc123',
            message: 'last commit',
            committedDate: '2026-01-02T12:00:00Z',
            author: {
              name: 'Octo Cat',
              user: { login: 'octo', avatarUrl: 'https://avatars/octo' },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

const page = (nodes: PRNode[], hasNextPage = false): PullRequestsData => ({
  repository: { pullRequests: { pageInfo: { hasNextPage, endCursor: 'CUR' }, nodes } },
});

describe('prStates / prOrder', () => {
  test('closed includes merged; all sends no filter', () => {
    expect(prStates('open')).toEqual(['OPEN']);
    expect(prStates('closed')).toEqual(['CLOSED', 'MERGED']);
    expect(prStates('all')).toBeNull();
  });

  test('maps the REST sort to the GraphQL order', () => {
    expect(prOrder('created', 'desc')).toEqual({ field: 'CREATED_AT', direction: 'DESC' });
    expect(prOrder('updated', 'asc')).toEqual({ field: 'UPDATED_AT', direction: 'ASC' });
    expect(prOrder('popularity', 'desc')).toEqual({ field: 'COMMENTS', direction: 'DESC' });
  });
});

describe('mapPullRequests', () => {
  test('maps a PR to the REST shape, last commit and commit count included', () => {
    const { prs } = mapPullRequests(page([prNode()]), 'acme');
    expect(prs).toEqual([
      {
        number: 12,
        title: 'Add thing',
        body: null,
        state: 'closed',
        html_url: 'https://github.com/acme/widget/pull/12',
        user: { login: 'octo', avatar_url: 'https://avatars/octo' },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        head: { ref: 'feature', label: 'fork-owner:feature', sha: 'abc123' },
        base: { ref: 'master', label: 'acme:master' },
        draft: false,
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [{ login: 'ann', avatar_url: 'https://avatars/ann' }],
        requested_reviewers: [{ login: 'rev', avatar_url: 'https://avatars/rev' }],
        commits: 4,
        merged_at: '2026-01-03T00:00:00Z',
        last_commit: {
          sha: 'abc123',
          message: 'last commit',
          author: { login: 'octo', avatar_url: 'https://avatars/octo' },
          author_name: 'Octo Cat',
          date: '2026-01-02T12:00:00Z',
        },
      },
    ]);
  });

  test('an open PR from a deleted fork, with no commits, still maps', () => {
    const [pr] = mapPullRequests(
      page([
        prNode({ state: 'OPEN', headRepositoryOwner: null, commits: { totalCount: 0, nodes: [] } }),
      ]),
      'acme',
    ).prs;
    expect(pr.state).toBe('open');
    expect(pr.head.label).toBe('acme:feature');
    expect(pr.last_commit).toBeNull();
  });

  test('returns the next cursor only while there are more pages', () => {
    expect(mapPullRequests(page([], true), 'acme')).toMatchObject({
      hasMore: true,
      nextCursor: 'CUR',
    });
    expect(mapPullRequests(page([], false), 'acme')).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(mapPullRequests({ repository: null }, 'acme')).toEqual({
      prs: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
