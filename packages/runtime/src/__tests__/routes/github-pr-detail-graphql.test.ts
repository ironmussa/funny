/**
 * The PR detail used five REST calls in two rounds, one of them the default
 * branch's check runs (not this PR's). It is now one GraphQL request; these
 * tests pin its mapping to the `PRDetail` the summary card and CI tab read.
 */
import { describe, expect, test } from 'vitest';

import {
  deriveReviewDecision,
  mapPRDetail,
  type PRDetailData,
} from '../../routes/github/pr-detail-graphql.js';

type PRNode = NonNullable<NonNullable<PRDetailData['repository']>['pullRequest']>;

function run(id: number, status: string, conclusion: string | null) {
  return {
    databaseId: id,
    name: `check-${id}`,
    status,
    conclusion,
    url: `https://github.com/acme/widget/runs/${id}`,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: status === 'COMPLETED' ? '2026-01-01T00:05:00Z' : null,
  };
}

function prNode(overrides: Partial<PRNode> = {}): PRNode {
  return {
    number: 12,
    title: 'Add thing',
    body: null,
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergeable: 'CONFLICTING',
    url: 'https://github.com/acme/widget/pull/12',
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
    headRefName: 'feature',
    headRefOid: 'abc123',
    baseRefName: 'master',
    reviews: { nodes: [{ state: 'APPROVED', author: { login: 'rev' } }] },
    commits: {
      totalCount: 4,
      nodes: [
        {
          commit: {
            oid: 'abc123',
            message: 'last commit',
            committedDate: '2026-01-02T12:00:00Z',
            author: { name: 'Octo Cat', user: null },
            checkSuites: {
              nodes: [
                {
                  app: { name: 'GitHub Actions' },
                  checkRuns: {
                    nodes: [
                      run(1, 'COMPLETED', 'SUCCESS'),
                      run(2, 'COMPLETED', 'FAILURE'),
                      run(3, 'IN_PROGRESS', null),
                    ],
                  },
                },
                // A suite with no runs (an app that reported nothing) adds nothing.
                { app: { name: 'Netlify' }, checkRuns: { nodes: [] } },
                {
                  app: null,
                  checkRuns: { nodes: [run(4, 'WAITING', null), run(5, 'COMPLETED', 'SKIPPED')] },
                },
              ],
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

const detail = (pr: PRNode | null) => mapPRDetail({ repository: { pullRequest: pr } });

describe('mapPRDetail', () => {
  test('maps the PR header, refs and stats', () => {
    expect(detail(prNode())).toMatchObject({
      number: 12,
      body: '',
      state: 'open',
      draft: false,
      merged: false,
      mergeable_state: 'conflicting',
      html_url: 'https://github.com/acme/widget/pull/12',
      additions: 10,
      deletions: 2,
      changed_files: 3,
      commits: 4,
      head: { ref: 'feature', sha: 'abc123' },
      base: { ref: 'master' },
      user: { login: 'octo', avatar_url: 'https://avatars/octo' },
      review_decision: 'APPROVED',
      last_commit: {
        sha: 'abc123',
        message: 'last commit',
        author: null,
        author_name: 'Octo Cat',
        date: '2026-01-02T12:00:00Z',
      },
    });
  });

  test('flattens the head commit check runs and tallies them', () => {
    const d = detail(prNode())!;
    expect(d.checks.map((c) => [c.id, c.status, c.conclusion, c.app_name])).toEqual([
      [1, 'completed', 'success', 'GitHub Actions'],
      [2, 'completed', 'failure', 'GitHub Actions'],
      [3, 'in_progress', null, 'GitHub Actions'],
      [4, 'queued', null, null],
      [5, 'completed', 'skipped', null],
    ]);
    expect(d.checks[0].html_url).toBe('https://github.com/acme/widget/runs/1');
    expect([d.checks_passed, d.checks_failed, d.checks_pending]).toEqual([2, 1, 2]);
  });

  test('a merged PR reports closed + merged', () => {
    expect(detail(prNode({ state: 'MERGED', merged: true }))).toMatchObject({
      state: 'closed',
      merged: true,
    });
  });

  test('a PR without commits has no checks and no last commit', () => {
    const d = detail(prNode({ commits: { totalCount: 0, nodes: [] } }))!;
    expect(d.checks).toEqual([]);
    expect(d.last_commit).toBeNull();
  });

  test('a missing PR or repository maps to null', () => {
    expect(detail(null)).toBeNull();
    expect(mapPRDetail({ repository: null })).toBeNull();
  });
});

describe('deriveReviewDecision', () => {
  test('the latest decisive review per author wins; changes requested outranks approval', () => {
    expect(
      deriveReviewDecision([
        { state: 'CHANGES_REQUESTED', login: 'a' },
        { state: 'APPROVED', login: 'a' },
        { state: 'APPROVED', login: 'b' },
      ]),
    ).toBe('APPROVED');
    expect(
      deriveReviewDecision([
        { state: 'APPROVED', login: 'a' },
        { state: 'CHANGES_REQUESTED', login: 'b' },
      ]),
    ).toBe('CHANGES_REQUESTED');
  });

  test('only comments means review required; no reviews means none', () => {
    expect(deriveReviewDecision([{ state: 'COMMENTED', login: 'a' }])).toBe('REVIEW_REQUIRED');
    expect(deriveReviewDecision([])).toBeNull();
  });
});
