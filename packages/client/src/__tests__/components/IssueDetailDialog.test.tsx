import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { EnrichedGitHubIssue, PRIssueComment } from '@funny/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { err, ok } from 'neverthrow';

const mocks = (() => ({ githubIssueComments: vi.fn() }))();
mock.module('@/lib/api', () => ({ api: { githubIssueComments: mocks.githubIssueComments } }));
mock.module('@/components/MarkdownBody', () => ({
  MarkdownBody: ({ body }: { body: string }) => <div>{body}</div>,
}));
mock.module('@/components/IssueBadges', () => ({ IssueBadges: () => null }));

const { IssueDetailDialog } = await import('@/components/IssueDetailDialog');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const withTooltips = { wrapper: TooltipProvider };

function makeIssue(overrides: Partial<EnrichedGitHubIssue> = {}): EnrichedGitHubIssue {
  return {
    number: 7,
    title: 'Issue title',
    state: 'open',
    body: 'Issue body',
    comments: 1,
    created_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/o/r/issues/7',
    user: null,
    labels: [],
    updated_at: '2026-01-01T00:00:00Z',
    linkedBranch: null,
    linkedPR: null,
    suggestedBranchName: 'issue-7',
    ...overrides,
  };
}

function makeComment(id: number, body: string): PRIssueComment {
  return {
    id,
    author: 'octocat',
    author_avatar_url: '',
    author_association: 'NONE',
    body,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: '',
    // SAFETY: the dialog does not render reactions.
    reactions: {} as PRIssueComment['reactions'],
  };
}

beforeEach(() => mocks.githubIssueComments.mockReset());
afterEach(cleanup);

describe('IssueDetailDialog comments', () => {
  test('an issue without comments shows none and makes no request', () => {
    render(
      <IssueDetailDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        issue={makeIssue({ comments: 0 })}
      />,
      withTooltips,
    );
    expect(screen.queryByTestId('issue-detail-comments-loading')).toBeNull();
    expect(screen.queryByTestId('issue-detail-comments')).toBeNull();
    expect(mocks.githubIssueComments).not.toHaveBeenCalled();
  });

  test('shows loading, then the fetched comments', async () => {
    mocks.githubIssueComments.mockResolvedValue(ok({ comments: [makeComment(1, 'first')] }));
    render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    expect(screen.getByTestId('issue-detail-comments-loading')).toBeTruthy();
    await screen.findByTestId('issue-detail-comment-1');
    expect(mocks.githubIssueComments).toHaveBeenCalledWith('p1', 7);
  });

  test('a failed request shows the error', async () => {
    mocks.githubIssueComments.mockResolvedValue(err({ message: 'boom' }));
    render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    const error = await screen.findByTestId('issue-detail-comments-error');
    expect(error.textContent).toContain('boom');
  });

  test('another issue shows loading instead of the previous issue’s comments', async () => {
    mocks.githubIssueComments.mockResolvedValueOnce(ok({ comments: [makeComment(1, 'first')] }));
    const { rerender } = render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    await screen.findByTestId('issue-detail-comment-1');

    mocks.githubIssueComments.mockReturnValueOnce(new Promise(() => {}));
    rerender(
      <IssueDetailDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        issue={makeIssue({ number: 8 })}
      />,
    );
    expect(screen.getByTestId('issue-detail-comments-loading')).toBeTruthy();
    expect(screen.queryByTestId('issue-detail-comment-1')).toBeNull();
  });

  test('reopening the dialog starts from loading again', async () => {
    mocks.githubIssueComments.mockResolvedValueOnce(ok({ comments: [makeComment(1, 'first')] }));
    const issue = makeIssue();
    const { rerender } = render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={issue} />,
      withTooltips,
    );
    await screen.findByTestId('issue-detail-comment-1');

    mocks.githubIssueComments.mockReturnValueOnce(new Promise(() => {}));
    rerender(
      <IssueDetailDialog open={false} onOpenChange={() => {}} projectId="p1" issue={issue} />,
    );
    rerender(<IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={issue} />);
    expect(screen.getByTestId('issue-detail-comments-loading')).toBeTruthy();
    expect(mocks.githubIssueComments).toHaveBeenCalledTimes(2);
  });
});
