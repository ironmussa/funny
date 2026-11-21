import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { Job, Watcher } from '@funny/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ActivityPanelButton } from '@/components/sidebar/ActivityPanelButton';
import { applyActivitiesRemoved } from '@/data/activities/apply-event';
import { buildActivity, seedActivities } from '@/data/activities/testing';
import { seedBackgroundActivity } from '@/data/background/testing';
import { useActivityPanelStore } from '@/stores/activity-panel-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCloneRetryStore } from '@/stores/clone-retry-store';
import { useProjectStore } from '@/stores/project-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const actions = (() => ({ cancelJob: vi.fn(), cancelWatcher: vi.fn() }))();
mock.module('@/data/background/actions', () => actions);

mock.module('react-i18next', () => ({
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

describe('ActivityPanelButton: jobs and watchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: false, isLoading: false, user: null });
    useProjectStore.setState({ selectedProjectId: 'project-1' });
    useThreadStore.setState({ activeThread: null });
    seedBackgroundActivity({});
    useActivityPanelStore.setState({ open: false, tab: 'jobs' });
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

    seedBackgroundActivity({
      jobs: [activeJob, historicalJob],
      watchers: [activeWatcher, historicalWatcher],
    });

    renderWithProviders(<ActivityPanelButton />);

    const trigger = screen.getByTestId('sidebar-activity');
    expect(within(trigger).getByText('2')).toBeInTheDocument();
    fireEvent.click(trigger);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expectBefore(
      screen.getByTestId('job-row-active-job'),
      screen.getByTestId('job-row-historical-job'),
    );

    // Jobs and watchers have their own tabs; each keeps active above history.
    act(() => useActivityPanelStore.setState({ tab: 'watchers' }));
    expectBefore(
      await screen.findByTestId('watcher-row-active-watcher'),
      screen.getByTestId('watcher-row-historical-watcher'),
    );
  });
  test('limits the preview to ten and searches the complete list', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) =>
      makeJob(`job-${i}`, {
        status: i === 11 ? 'running' : 'exited',
      }),
    );
    seedBackgroundActivity({ jobs });
    renderWithProviders(<ActivityPanelButton />);
    fireEvent.click(screen.getByTestId('sidebar-activity'));
    const panel = await screen.findByTestId('watcher-panel');
    expect(within(panel).getAllByTestId(/^job-row-/)).toHaveLength(10);
    expect(within(panel).getByTestId('job-row-job-11')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Stop process' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'View more (2)' }));
    const view = await screen.findByTestId('watchers-view');
    expect(within(view).getAllByTestId(/^job-row-/)).toHaveLength(12);
    fireEvent.change(within(view).getByPlaceholderText('Search watchers and commands…'), {
      target: { value: 'job-10' },
    });
    expect(within(view).getAllByTestId(/^job-row-/)).toHaveLength(1);
    fireEvent.click(within(view).getByRole('button', { name: 'Active (1)' }));
    expect(within(view).getByText('No matching background activity.')).toBeInTheDocument();
  });

  test('requires confirmation before stopping a process', async () => {
    seedBackgroundActivity({ jobs: [makeJob('running', { status: 'running' })] });
    renderWithProviders(<ActivityPanelButton />);
    fireEvent.click(screen.getByTestId('sidebar-activity'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop process' }));
    expect(actions.cancelJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(actions.cancelJob).toHaveBeenCalledWith('running');
  });
});

const activityActions = (() => ({
  dismissActivity: vi.fn(),
  clearFinishedActivities: vi.fn(),
}))();
mock.module('@/data/activities/actions', () => activityActions);

const navigate = (() => vi.fn())();
// bun has no importOriginal: copy the real module before mocking it.
const actualRouter = { ...(await import('react-router-dom')) };
mock.module('react-router-dom', () => ({
  ...actualRouter,
  useNavigate: () => navigate,
}));

describe('ActivityPanelButton: activity tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedBackgroundActivity({});
    seedActivities([]);
    useRunnerStatusStore.setState({ status: 'online' });
    useActivityPanelStore.setState({ open: false, tab: 'activity' });
    useCloneRetryStore.setState({ pending: null });
    useUIStore.setState({ addProjectOpen: false });
  });

  const openPanel = async () => {
    fireEvent.click(screen.getByTestId('sidebar-activity'));
    return screen.findByTestId('activity-panel');
  };

  test('lists running first, then finished newest first, with the error text', async () => {
    seedActivities([
      buildActivity({ id: 'old', status: 'succeeded', endedAt: '2026-11-20T10:01:00.000Z' }),
      buildActivity({
        id: 'new',
        status: 'failed',
        error: 'destination exists',
        endedAt: '2026-11-20T10:05:00.000Z',
      }),
      buildActivity({ id: 'run', status: 'running', step: 'Cloning' }),
    ]);
    renderWithProviders(<ActivityPanelButton />);
    const panel = await openPanel();
    const rows = within(panel).getAllByTestId(/^activity-item-(old|new|run)$/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'activity-item-run',
      'activity-item-new',
      'activity-item-old',
    ]);
    expect(screen.getByTestId('activity-item-detail-new')).toHaveTextContent('destination exists');
    expect(screen.getByTestId('activity-item-detail-run')).toHaveTextContent('Cloning');
    // Text scales with the font-size setting: no pixel sizes on the rows.
    expect(rows[0].innerHTML).not.toMatch(/text-\[\d+px\]/);
  });

  test('shows "runner offline" on a running row whose runner is gone, and lets it be dismissed', async () => {
    useRunnerStatusStore.setState({ status: 'offline' });
    seedActivities([buildActivity({ id: 'run', status: 'running' })]);
    renderWithProviders(<ActivityPanelButton />);
    await openPanel();
    expect(screen.getByTestId('activity-item-detail-run')).toHaveTextContent(
      'activity.runnerOffline',
    );
    fireEvent.click(screen.getByTestId('activity-item-dismiss-run'));
    expect(activityActions.dismissActivity).toHaveBeenCalledWith('run');
  });

  test('hides dismiss on a running row whose runner is connected; clear finished is offered', async () => {
    seedActivities([
      buildActivity({ id: 'run', status: 'running' }),
      buildActivity({ id: 'done', status: 'succeeded' }),
    ]);
    renderWithProviders(<ActivityPanelButton />);
    await openPanel();
    expect(screen.queryByTestId('activity-item-dismiss-run')).toBeNull();
    expect(screen.getByTestId('activity-item-dismiss-done')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('activity-panel-clear-finished'));
    expect(activityActions.clearFinishedActivities).toHaveBeenCalled();
  });

  test('counts two running and one failed, and drops to no failure badge once it is gone', async () => {
    seedActivities([
      buildActivity({ id: 'a', status: 'running' }),
      buildActivity({ id: 'b', status: 'running' }),
      buildActivity({ id: 'c', status: 'failed' }),
    ]);
    renderWithProviders(<ActivityPanelButton />);
    const trigger = screen.getByTestId('sidebar-activity');
    expect(await within(trigger).findByText('2')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-activity-failed-count')).toHaveTextContent('1');

    act(() => applyActivitiesRemoved({ ids: ['c'] }));
    await waitFor(() => expect(screen.queryByTestId('sidebar-activity-failed-count')).toBeNull());
  });

  test('retrying a failed clone opens the clone form with its values and starts nothing', async () => {
    seedActivities([
      buildActivity({
        id: 'c1',
        status: 'failed',
        input: {
          cloneUrl: 'https://github.com/acme/widget.git',
          destinationPath: '/code',
          name: 'widget',
        },
      }),
    ]);
    renderWithProviders(<ActivityPanelButton />);
    await openPanel();
    fireEvent.click(screen.getByTestId('activity-item-retry-c1'));
    expect(useCloneRetryStore.getState().pending).toEqual({
      cloneUrl: 'https://github.com/acme/widget.git',
      destinationPath: '/code',
      name: 'widget',
    });
    expect(useUIStore.getState().addProjectOpen).toBe(true);
    expect(activityActions.dismissActivity).not.toHaveBeenCalled();
  });
});
