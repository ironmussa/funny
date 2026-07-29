import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadChatView } from '@/components/thread/ThreadChatView';
import type { ThreadCore } from '@/stores/thread-context';

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

describe('ThreadChatView in-thread search', () => {
  test('Escape closes an open search when focus is elsewhere in the thread', () => {
    render(<ThreadChatView activeThread={{ id: 'thread-1', status: 'idle' } as ThreadCore} />);

    const threadContent = screen.getByTestId('thread-content');
    fireEvent.keyDown(threadContent, { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('thread-search-bar')).toBeVisible();

    threadContent.focus();
    fireEvent.keyDown(threadContent, { key: 'Escape' });

    expect(screen.queryByTestId('thread-search-bar')).not.toBeInTheDocument();
  });
});
