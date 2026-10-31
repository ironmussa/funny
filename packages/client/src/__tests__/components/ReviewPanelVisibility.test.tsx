import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphPanel, IssuesPanel, PRsPanel } from '@/components/review-pane/panels/ChangesPanel';

const context = vi.hoisted(() => ({ reviewSubTab: 'changes', reviewPaneOpen: true }));
vi.mock('@/components/review-pane/ReviewPaneStateContext', () => ({
  useReviewPaneContext: () => context,
}));
vi.mock('@/components/CommitGraphTab', () => ({
  CommitGraphTab: ({ visible }: { visible: boolean }) => (
    <div data-testid="graph" data-fetch-enabled={visible} />
  ),
}));
vi.mock('@/components/PullRequestsTab', () => ({
  PullRequestsTab: ({ visible }: { visible: boolean }) => (
    <div data-testid="prs" data-fetch-enabled={visible} />
  ),
}));
vi.mock('@/components/IssuesTab', () => ({
  IssuesTab: ({ visible }: { visible: boolean }) => (
    <div data-testid="issues" data-fetch-enabled={visible} />
  ),
}));
vi.mock('@/components/review-pane/ReviewChangesTab', () => ({
  ReviewChangesTabContent: () => null,
}));
vi.mock('@/components/review-pane/StashTab', () => ({ StashTab: () => null }));

const panels = [
  ['graph', GraphPanel],
  ['prs', PRsPanel],
  ['issues', IssuesPanel],
] as const;

describe('mounted Dockview panels', () => {
  test.each(panels)('%s only enables fetching while its tab and pane are visible', (tab, Panel) => {
    context.reviewSubTab = 'changes';
    context.reviewPaneOpen = true;
    const view = render(<Panel />);
    expect(screen.getByTestId(tab)).toHaveAttribute('data-fetch-enabled', 'false');

    context.reviewSubTab = tab;
    view.rerender(<Panel />);
    expect(screen.getByTestId(tab)).toHaveAttribute('data-fetch-enabled', 'true');

    context.reviewSubTab = 'changes';
    view.rerender(<Panel />);
    expect(screen.getByTestId(tab)).toHaveAttribute('data-fetch-enabled', 'false');

    context.reviewSubTab = tab;
    context.reviewPaneOpen = false;
    view.rerender(<Panel />);
    expect(screen.getByTestId(tab)).toHaveAttribute('data-fetch-enabled', 'false');
  });
});
