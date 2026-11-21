import { describe, expect, test, vi } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/PipelineProgressBanner', () => ({
  PipelineProgressBanner: () => null,
}));

vi.mock('@/components/thread/PromptTimeline', () => ({
  PromptTimeline: () => null,
}));

vi.mock('@/components/thread/ThreadConversation', () => ({
  ThreadConversation: ({ searchBar }: { searchBar: React.ReactNode }) => (
    <div>
      <button data-testid="thread-content">Thread content</button>
      {searchBar}
    </div>
  ),
}));

vi.mock('@/components/thread/ThreadSearchBar', () => ({
  ThreadSearchBar: ({ open }: { open: boolean }) =>
    open ? <div data-testid="thread-search-bar">Search</div> : null,
}));

vi.mock('@/stores/thread-context', () => ({
  useThreadMessages: () => [],
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: (
    selector: (state: { timelineVisible: boolean; pendingThreadSearch: null }) => unknown,
  ) => selector({ timelineVisible: false, pendingThreadSearch: null }),
}));

const { ThreadChatView } = await import('@/components/thread/ThreadChatView');
const { buildThread } = await import('@/data/threads/testing');

describe('ThreadChatView in-thread search', () => {
  test('Escape closes an open search when focus is elsewhere in the thread', () => {
    render(<ThreadChatView activeThread={buildThread({ id: 'thread-1', status: 'idle' })} />);

    const threadContent = screen.getByTestId('thread-content');
    fireEvent.keyDown(threadContent, { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('thread-search-bar')).toBeVisible();

    threadContent.focus();
    fireEvent.keyDown(threadContent, { key: 'Escape' });

    expect(screen.queryByTestId('thread-search-bar')).not.toBeInTheDocument();
  });
});
