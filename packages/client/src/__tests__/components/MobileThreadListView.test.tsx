import type { GitStatusInfo, Project, Thread } from '@funny/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { ThreadListView } from '@/components/mobile/ThreadListView';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getItemKey,
  }: {
    count: number;
    estimateSize: () => number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * estimateSize(),
      })),
    getTotalSize: () => count * estimateSize(),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

const { threads } = vi.hoisted(() => ({ threads: [] as Thread[] }));
vi.mock('@/lib/thread-selectors', () => ({ useThreadsForProject: () => threads }));

const ensureStatus = vi.fn();
beforeEach(() => {
  threads.splice(0, threads.length, {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Hola',
    status: 'completed',
    mode: 'local',
    branch: 'main',
    provider: 'claude-sdk',
    cost: 0,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    lastAssistantMessage: 'Resumen del trabajo realizado',
  } as Thread);
  useAppStore.setState({
    projects: [{ id: 'project-1', name: 'goliiive-cashless', path: '/repo' } as Project],
    loadThreadsForProject: vi.fn(),
  });
  useGitStatusStore.setState({
    statusByBranch: {},
    threadToBranchKey: {},
    ensureStatusForThreads: ensureStatus,
  });
});

test('shows desktop metadata on mobile and updates diff stats when git status arrives', () => {
  const onSelectThread = vi.fn();
  renderWithProviders(
    <ThreadListView
      projectId="project-1"
      onSelectThread={onSelectThread}
      onBack={vi.fn()}
      onNewThread={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
    />,
  );

  expect(screen.getByTestId('thread-powerline-thread-1')).toHaveTextContent('main');
  expect(screen.getByText('Resumen del trabajo realizado')).toBeVisible();
  const row = screen.getByTestId('thread-item-thread-1').parentElement!;
  const time = row.querySelector('.text-right');
  expect(time).toBeVisible();
  expect(time?.textContent).toBeTruthy();
  expect(time?.className).not.toContain('hidden');
  expect(ensureStatus).toHaveBeenCalledWith([threads[0]]);

  act(() =>
    useGitStatusStore.setState({
      statusByBranch: {
        'project-1:main': {
          threadId: 'thread-1',
          branchKey: 'project-1:main',
          state: 'dirty',
          dirtyFileCount: 2,
          linesAdded: 12,
          linesDeleted: 3,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
        } as GitStatusInfo,
      },
      threadToBranchKey: { 'thread-1': 'project-1:main' },
    }),
  );
  expect(screen.getByText('+12')).toBeVisible();
  expect(screen.getByText('-3')).toBeVisible();
  fireEvent.click(screen.getByTestId('thread-item-thread-1'));
  expect(onSelectThread).toHaveBeenCalledWith('thread-1');
  expect(row.querySelector('button button')).toBeNull();
});
