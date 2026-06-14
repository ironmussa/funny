import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { MobilePage } from '@/components/MobilePage';

// Regression: on mobile, opening a thread from the search results and then
// pressing Back must return to the search screen (with the query intact), not
// jump all the way back to the project's thread list. Previously ChatView's
// onBack always went to the `threads` screen, dropping the user out of search.

vi.mock('@/hooks/use-ws', () => ({ useWS: () => {} }));

vi.mock('@/stores/app-store', () => ({
  useAppStore: (selector: (s: any) => any) =>
    selector({
      loadProjects: () => Promise.resolve(),
      projects: [{ id: 'p1', name: 'Proj' }],
    }),
}));

vi.mock('@/stores/thread-context', () => ({
  ThreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

vi.mock('@/components/mobile/ProjectListView', () => ({
  ProjectListView: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="select-project" onClick={() => onSelect('p1')} />
  ),
}));

vi.mock('@/components/mobile/ThreadListView', () => ({
  ThreadListView: ({ onSearch }: { onSearch: () => void }) => (
    <div data-testid="screen-threads">
      <button data-testid="open-search" onClick={onSearch} />
    </div>
  ),
}));

vi.mock('@/components/mobile/NewThreadView', () => ({
  NewThreadView: () => <div data-testid="screen-new-thread" />,
}));

vi.mock('@/components/mobile/SearchView', () => ({
  SearchView: ({
    query,
    onSelectThread,
  }: {
    query: string;
    onSelectThread: (id: string) => void;
  }) => (
    <div data-testid="screen-search" data-query={query}>
      <button data-testid="select-result" onClick={() => onSelectThread('t1')} />
    </div>
  ),
}));

vi.mock('@/components/mobile/ChatView', () => ({
  ChatView: ({ onBack }: { onBack: () => void }) => (
    <button data-testid="chat-back" onClick={onBack} />
  ),
}));

describe('MobilePage search → result → back', () => {
  test('Back from a chat opened via search returns to the search screen', async () => {
    render(<MobilePage />);

    fireEvent.click(await screen.findByTestId('select-project'));
    fireEvent.click(screen.getByTestId('open-search'));
    await waitFor(() => expect(screen.getByTestId('screen-search')).toBeTruthy());

    fireEvent.click(screen.getByTestId('select-result'));
    fireEvent.click(await screen.findByTestId('chat-back'));

    // Returns to search, not the thread list.
    expect(screen.getByTestId('screen-search')).toBeTruthy();
    expect(screen.queryByTestId('screen-threads')).toBeNull();
  });

  test('Back from a chat opened via the thread list returns to the thread list', async () => {
    const { unmount } = render(<MobilePage />);

    fireEvent.click(await screen.findByTestId('select-project'));
    await waitFor(() => expect(screen.getByTestId('screen-threads')).toBeTruthy());

    // Navigate seam (e.g. result toast) opens chat with from: 'threads'.
    const { getNavigate } = await import('@/stores/thread-store-internals');
    act(() => {
      getNavigate()?.('/projects/p1/threads/t1');
    });
    fireEvent.click(await screen.findByTestId('chat-back'));

    expect(screen.getByTestId('screen-threads')).toBeTruthy();
    expect(screen.queryByTestId('screen-search')).toBeNull();
    unmount();
  });
});
