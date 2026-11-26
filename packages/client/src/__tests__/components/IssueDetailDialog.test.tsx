import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { EnrichedGitHubIssue, IssueTimelineItem, PRIssueComment } from '@funny/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { err, ok } from 'neverthrow';

const mocks = (() => ({ githubIssueTimeline: vi.fn() }))();
mock.module('@/lib/api', () => ({ api: { githubIssueTimeline: mocks.githubIssueTimeline } }));
mock.module('@/components/MarkdownBody', () => ({
  MarkdownBody: ({ body }: { body: string }) => <div>{body}</div>,
}));
mock.module('@/components/IssueBadges', () => ({ IssueBadges: () => null }));

const { IssueDetailDialog } = await import('@/components/IssueDetailDialog');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { useGitHubItemViewerStore } = await import('@/stores/github-item-viewer-store');
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

function commentItem(id: number, body: string): IssueTimelineItem {
  return { type: 'comment', comment: makeComment(id, body) };
}

beforeEach(() => mocks.githubIssueTimeline.mockReset());
afterEach(cleanup);

describe('IssueDetailDialog timeline', () => {
  test('shows the events between the comments, with the pull request that closed it', async () => {
    const actor = { login: 'argenisleon', avatar_url: '' };
    mocks.githubIssueTimeline.mockResolvedValue(
      ok({
        items: [
          {
            type: 'labeled',
            id: 'L1',
            created_at: '2026-01-01T00:00:00Z',
            actor,
            label: { name: 'ready-for-agent', color: '0e8a16' },
          },
          {
            type: 'cross-referenced',
            id: 'X1',
            created_at: '2026-01-01T00:00:00Z',
            actor,
            willClose: false,
            source: {
              kind: 'pr',
              number: 559,
              title: 'chore(lint)',
              url: 'https://github.com/o/r/pull/559',
              state: 'merged',
              repo: 'o/r',
            },
          },
          {
            type: 'closed',
            id: 'C1',
            created_at: '2026-01-01T00:00:00Z',
            actor: { login: 'funny-localhost-1', avatar_url: '' },
            stateReason: 'completed',
            closer: {
              kind: 'pr',
              ref: {
                kind: 'pr',
                number: 559,
                title: 'chore(lint)',
                url: 'https://github.com/o/r/pull/559',
                state: 'merged',
                repo: 'o/r',
              },
            },
          },
        ] satisfies IssueTimelineItem[],
      }),
    );
    render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    const labeled = await screen.findByTestId('issue-detail-event-labeled');
    expect(labeled.textContent).toContain('ready-for-agent');
    expect(screen.getByTestId('issue-detail-event-cross-referenced').textContent).toContain(
      'chore(lint)',
    );
    const closed = screen.getByTestId('issue-detail-event-closed');
    expect(closed.textContent).toContain('closed this as completed');
    expect(closed.textContent).toContain('#559');

    // A pull request of the issue's own repository opens in funny's PR view.
    fireEvent.click(within(closed).getByTestId('issue-detail-ref-pr-559'));
    expect(useGitHubItemViewerStore.getState().target).toEqual({
      kind: 'pr',
      projectId: 'p1',
      number: 559,
      url: 'https://github.com/o/r/pull/559',
    });
  });

  test('shows loading, then the fetched comments', async () => {
    mocks.githubIssueTimeline.mockResolvedValue(ok({ items: [commentItem(1, 'first')] }));
    render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    expect(screen.getByTestId('issue-detail-timeline-loading')).toBeTruthy();
    await screen.findByTestId('issue-detail-comment-1');
    expect(mocks.githubIssueTimeline).toHaveBeenCalledWith('p1', 7);
  });

  test('a failed request shows the error', async () => {
    mocks.githubIssueTimeline.mockResolvedValue(err({ message: 'boom' }));
    render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    const error = await screen.findByTestId('issue-detail-timeline-error');
    expect(error.textContent).toContain('boom');
  });

  test('another issue shows loading instead of the previous issue’s comments', async () => {
    mocks.githubIssueTimeline.mockResolvedValueOnce(ok({ items: [commentItem(1, 'first')] }));
    const { rerender } = render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={makeIssue()} />,
      withTooltips,
    );
    await screen.findByTestId('issue-detail-comment-1');

    mocks.githubIssueTimeline.mockReturnValueOnce(new Promise(() => {}));
    rerender(
      <IssueDetailDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        issue={makeIssue({ number: 8 })}
      />,
    );
    expect(screen.getByTestId('issue-detail-timeline-loading')).toBeTruthy();
    expect(screen.queryByTestId('issue-detail-comment-1')).toBeNull();
  });

  test('reopening the dialog starts from loading again', async () => {
    mocks.githubIssueTimeline.mockResolvedValueOnce(ok({ items: [commentItem(1, 'first')] }));
    const issue = makeIssue();
    const { rerender } = render(
      <IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={issue} />,
      withTooltips,
    );
    await screen.findByTestId('issue-detail-comment-1');

    mocks.githubIssueTimeline.mockReturnValueOnce(new Promise(() => {}));
    rerender(
      <IssueDetailDialog open={false} onOpenChange={() => {}} projectId="p1" issue={issue} />,
    );
    rerender(<IssueDetailDialog open onOpenChange={() => {}} projectId="p1" issue={issue} />);
    expect(screen.getByTestId('issue-detail-timeline-loading')).toBeTruthy();
    expect(mocks.githubIssueTimeline).toHaveBeenCalledTimes(2);
  });
});
