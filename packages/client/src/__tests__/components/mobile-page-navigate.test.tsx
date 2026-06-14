import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { MobilePage } from '@/components/MobilePage';
import { getNavigate } from '@/stores/thread-store-internals';

// Regression: on mobile the UI navigates via local view state, not react-router.
// The agent-result toast's "View" action calls the store navigate seam
// (setAppNavigate / getNavigate). If MobilePage doesn't register a handler, that
// navigate is a no-op and "View" never opens the thread. These tests lock in that
// MobilePage registers a seam that switches the mobile view to the target thread.

vi.mock('@/hooks/use-ws', () => ({ useWS: () => {} }));

vi.mock('@/stores/app-store', () => ({
  useAppStore: (selector: (s: any) => any) =>
    selector({ loadProjects: () => Promise.resolve(), projects: [] }),
}));

vi.mock('@/stores/thread-context', () => ({
  ThreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

vi.mock('@/components/mobile/ProjectListView', () => ({
  ProjectListView: () => <div data-testid="screen-projects" />,
}));
vi.mock('@/components/mobile/ThreadListView', () => ({
  ThreadListView: ({ projectId }: { projectId: string }) => (
    <div data-testid={`screen-threads-${projectId}`} />
  ),
}));
vi.mock('@/components/mobile/NewThreadView', () => ({
  NewThreadView: () => <div data-testid="screen-new-thread" />,
}));
vi.mock('@/components/mobile/ChatView', () => ({
  ChatView: ({ projectId, threadId }: { projectId: string; threadId: string }) => (
    <div data-testid={`screen-chat-${projectId}-${threadId}`} />
  ),
}));

describe('MobilePage navigate seam', () => {
  test('store navigate to a thread route opens the chat view', async () => {
    render(<MobilePage />);
    await waitFor(() => expect(screen.getByTestId('screen-projects')).toBeTruthy());

    act(() => {
      getNavigate()?.('/projects/p1/threads/t1');
    });

    expect(screen.getByTestId('screen-chat-p1-t1')).toBeTruthy();
  });

  test('org-prefixed thread route is parsed and opens the chat view', async () => {
    render(<MobilePage />);
    await waitFor(() => expect(screen.getAllByTestId('screen-projects').length).toBeGreaterThan(0));

    act(() => {
      getNavigate()?.('/acme/projects/p2/threads/t2');
    });

    expect(screen.getByTestId('screen-chat-p2-t2')).toBeTruthy();
  });
});
