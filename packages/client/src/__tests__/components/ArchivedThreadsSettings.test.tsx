import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ArchivedThreadsSettings } from '@/components/ArchivedThreadsSettings';
import { useAppStore } from '@/stores/app-store';

const listArchivedThreads = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ api: { listArchivedThreads } }));
vi.mock('@/components/ThreadPowerline', () => ({ ThreadPowerline: () => null }));
vi.mock('@/components/VirtualThreadList', () => ({
  VirtualThreadList: ({
    threads,
    onEndReached,
  }: {
    threads: unknown[];
    onEndReached: () => void;
  }) => (
    <div>
      <span data-testid="archived-thread-count">{threads.length}</span>
      <button onClick={onEndReached}>Load more</button>
    </div>
  ),
}));

const okPage = (page: number) => ({
  isOk: () => true,
  value: {
    threads: Array.from({ length: page === 3 ? 50 : 100 }, (_, index) => ({
      id: `thread-${page}-${index}`,
      projectId: 'project-1',
    })),
    total: 250,
  },
});

describe('ArchivedThreadsSettings pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ projects: [], selectedProjectId: null } as never);
    listArchivedThreads.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve(okPage(page)),
    );
  });

  test('increments the transient page counter across load-more events', async () => {
    render(<ArchivedThreadsSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('archived-thread-count')).toHaveTextContent('100'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(screen.getByTestId('archived-thread-count')).toHaveTextContent('200'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(screen.getByTestId('archived-thread-count')).toHaveTextContent('250'),
    );

    expect(listArchivedThreads.mock.calls.map(([options]) => options.page)).toEqual([1, 2, 3]);
  });
});
