import { describe, expect, test, mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';

mock.module('@/components/PipelineProgressBanner', () => ({
  PipelineProgressBanner: () => null,
}));

mock.module('@/components/thread/PromptTimeline', () => ({
  PromptTimeline: () => null,
}));

mock.module('@/components/thread/ThreadConversation', () => ({
  ThreadConversation: ({ searchBar }: { searchBar: React.ReactNode }) => (
    <div>
      <button data-testid="thread-content">Thread content</button>
      {searchBar}
    </div>
  ),
}));

mock.module('@/components/thread/ThreadSearchBar', () => ({
  ThreadSearchBar: ({ open }: { open: boolean }) =>
    open ? <div data-testid="thread-search-bar">Search</div> : null,
}));

mock.module('@/stores/thread-context', () => ({
  useThreadMessages: () => [],
}));

mock.module('@/stores/ui-store', () => ({
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
