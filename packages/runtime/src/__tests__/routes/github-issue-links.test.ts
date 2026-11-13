/**
 * The Issues panel showed the PR badge only when a LOCAL branch carried the
 * issue number and an OPEN PR came from that branch. A PR that says
 * `Fixes #N`, or whose branch exists only on GitHub, or that was merged, left
 * the issue without a badge.
 */
import type { GitHubIssue } from '@funny/shared';
import { describe, expect, test } from 'vitest';

import {
  closingReferences,
  issueNumberInBranch,
  linkIssues,
  type LinkablePR,
} from '../../routes/github/issue-links.js';

function issue(number: number): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://github.com/acme/widget/issues/${number}`,
    user: null,
    labels: [],
    comments: 0,
  };
}

function pr(number: number, overrides: Partial<Omit<LinkablePR, 'number'>> = {}): LinkablePR {
  return {
    number,
    url: `https://github.com/acme/widget/pull/${number}`,
    title: `PR ${number}`,
    state: 'open',
    merged: false,
    headRef: `feature-${number}x`,
    closes: [],
    ...overrides,
  };
}

const link = (issues: GitHubIssue[], pullRequests: LinkablePR[], branches: string[] = []) =>
  linkIssues(issues, {
    branches,
    pullRequests,
    repo: 'acme/widget',
    suggestBranchName: (i) => `issue-${i.number}`,
  });

describe('closingReferences', () => {
  test('reads GitHub closing keywords', () => {
    expect(closingReferences('Fixes #12, closes #13 and resolved: #14')).toEqual([12, 13, 14]);
  });

  test('ignores plain mentions and other repositories', () => {
    expect(closingReferences('See #12. Fixes other/repo#13', 'acme/widget')).toEqual([]);
    expect(closingReferences('Fixes acme/widget#13', 'acme/widget')).toEqual([13]);
  });
});

describe('issueNumberInBranch', () => {
  test('finds the number between separators', () => {
    expect(issueNumberInBranch('issue-42-fix-bug')).toBe(42);
    expect(issueNumberInBranch('fix/42-thing')).toBe(42);
    expect(issueNumberInBranch('v2fix')).toBeNull();
  });
});

describe('linkIssues', () => {
  test('links a PR that GitHub records as closing the issue', () => {
    const [linked] = link([issue(181)], [pr(200, { closes: [181] })]);
    expect(linked.linkedPR).toEqual({
      number: 200,
      url: 'https://github.com/acme/widget/pull/200',
      state: 'open',
    });
  });

  test('links a PR by its remote branch even without a local branch', () => {
    const [linked] = link([issue(42)], [pr(50, { headRef: 'issue-42-fix' })]);
    expect(linked.linkedPR?.number).toBe(50);
    expect(linked.linkedBranch).toBe('issue-42-fix');
  });

  test('reports a merged PR as merged and keeps the issue startable', () => {
    const [linked] = link([issue(7)], [pr(9, { closes: [7], state: 'closed', merged: true })]);
    expect(linked.linkedPR?.state).toBe('merged');
    expect(linked.linkedBranch).toBeNull();
  });

  test('prefers an open PR over a closed one for the same issue', () => {
    const [linked] = link(
      [issue(7)],
      [pr(8, { closes: [7], state: 'closed' }), pr(9, { closes: [7] })],
    );
    expect(linked.linkedPR?.number).toBe(9);
  });

  test('links a PR whose title closes the issue', () => {
    const [linked] = link([issue(5)], [pr(6, { title: 'Fix #5: crash on load' })]);
    expect(linked.linkedPR?.number).toBe(6);
  });

  test('leaves an issue without a PR unlinked', () => {
    const [linked] = link([issue(3)], [pr(4, { title: 'Refs #3' })], ['issue-3-local']);
    expect(linked.linkedPR).toBeNull();
    expect(linked.linkedBranch).toBe('issue-3-local');
    expect(linked.suggestedBranchName).toBe('issue-3');
  });
});
