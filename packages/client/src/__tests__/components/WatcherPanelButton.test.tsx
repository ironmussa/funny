import type { Job, Watcher } from '@funny/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { WatcherPanelButton } from '@/components/sidebar/WatcherPanelButton';
import { useAuthStore } from '@/stores/auth-store';
import { useJobStore } from '@/stores/job-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useWatcherStore } from '@/stores/watcher-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    command: 'bun run import',
    cwd: '/repo',
    label: id,
    pid: id === 'active-job' ? 123 : null,
    logPath: `/tmp/${id}.log`,
    exitPath: `/tmp/${id}.exit`,
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

function makeWatcher(id: string, overrides: Partial<Watcher> = {}): Watcher {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    key: id,
    label: id,
    nextWakeAt: Date.parse('2026-01-01T00:30:00.000Z'),
    lastDelayMs: 60_000,
    wakeCount: 0,
    maxWakes: 20,
    deadline: null,
    status: 'done',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

function expectBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('WatcherPanelButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: false, isLoading: false, user: null });
    useProjectStore.setState({ selectedProjectId: 'project-1' } as any);
    useThreadStore.setState({ activeThread: null } as any);
    useJobStore.setState({ jobsById: {} });
    useWatcherStore.setState({ watchersById: {} });
  });

  test('groups active jobs and pending watchers above history', async () => {
    const activeJob = makeJob('active-job', {
      status: 'running',
      startedAt: '2026-01-01T00:05:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
    });
    const historicalJob = makeJob('historical-job', {
      startedAt: '2026-01-01T00:20:00.000Z',
      updatedAt: '2026-01-01T00:25:00.000Z',
    });
    const activeWatcher = makeWatcher('active-watcher', {
      status: 'pending',
      createdAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    const historicalWatcher = makeWatcher('historical-watcher', {
      createdAt: '2026-01-01T00:30:00.000Z',
      updatedAt: '2026-01-01T00:35:00.000Z',
    });

    useJobStore.setState({
      jobsById: {
        [activeJob.id]: activeJob,
        [historicalJob.id]: historicalJob,
      },
    });
    useWatcherStore.setState({
      watchersById: {
        [activeWatcher.id]: activeWatcher,
        [historicalWatcher.id]: historicalWatcher,
      },
    });

    renderWithProviders(<WatcherPanelButton />);

    const trigger = screen.getByTestId('sidebar-watchers');
    expect(within(trigger).getByText('2')).toBeInTheDocument();
    fireEvent.click(trigger);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();

    const activeJobRow = screen.getByTestId('job-row-active-job');
    const activeWatcherRow = screen.getByTestId('watcher-row-active-watcher');
    const historicalJobRow = screen.getByTestId('job-row-historical-job');
    const historicalWatcherRow = screen.getByTestId('watcher-row-historical-watcher');

    expectBefore(activeJobRow, historicalJobRow);
    expectBefore(activeWatcherRow, historicalJobRow);
    expectBefore(activeWatcherRow, historicalWatcherRow);
  });
});
