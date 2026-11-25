import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ArchivedThreadsSettings } from '@/components/ArchivedThreadsSettings';
import { withProjects } from '@/data/projects/testing';
import { useAppStore } from '@/stores/app-store';

const listArchivedThreads = (() => vi.fn())();

mock.module('@/lib/api', () => ({ api: { listArchivedThreads } }));
mock.module('@/components/ThreadPowerline', () => ({ ThreadPowerline: () => null }));
mock.module('@/components/VirtualThreadList', () => ({
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
    useAppStore.setState(withProjects({ projects: [], selectedProjectId: null }));
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

describe('ArchivedThreadsSettings first page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(withProjects({ projects: [], selectedProjectId: null }));
  });

  test('a superseded first page that settles last neither shows loading nor replaces the list', async () => {
    const pending: Array<{ search?: string; settle: (count: number) => void }> = [];
    listArchivedThreads.mockImplementation(
      ({ search }: { search?: string }) =>
        new Promise((resolve) => {
          pending.push({
            search,
            settle: (count) =>
              resolve({
                isOk: () => true,
                value: {
                  threads: Array.from({ length: count }, (_, index) => ({
                    id: `thread-${search ?? 'all'}-${index}`,
                    projectId: 'project-1',
                  })),
                  total: count,
                },
              }),
          });
        }),
    );

    render(<ArchivedThreadsSettings />);
    fireEvent.change(screen.getByTestId('archived-search-input'), { target: { value: 'ab' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    const [first, second] = pending;
    expect(second.search).toBe('ab');

    // The newer search answers first, then the superseded first page.
    second.settle(3);
    await waitFor(() => expect(screen.getByTestId('archived-thread-count')).toHaveTextContent('3'));
    first.settle(7);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('archived-loading')).toBeNull();
    expect(screen.getByTestId('archived-thread-count')).toHaveTextContent('3');
  });
});
