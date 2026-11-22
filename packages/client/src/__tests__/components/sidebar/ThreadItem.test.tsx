import { describe, expect, test, vi, mock } from 'bun:test';

import type { GitStatusInfo, Thread } from '@funny/shared';
import { act, fireEvent, screen } from '@testing-library/react';

import { ThreadItem } from '@/components/sidebar/ThreadItem';
import { seedBackgroundActivity } from '@/data/background/testing';
import { activeFactoryRunsQuery } from '@/data/factory/queries';
import { buildFactoryRun } from '@/data/factory/testing';
import { getDataLayer } from '@/data/runtime';
import { buildThread } from '@/data/threads/testing';
import type { FactoryRun } from '@/lib/api/factory';
import { useBrowserLiveThreadsStore } from '@/stores/browser-live-threads-store';
import { useThreadActiveToolStore } from '@/stores/thread-active-tool-store';

import { buildJob, buildWatcher } from '../../helpers/builders-lib';
import { mockT } from '../../helpers/mock-i18n';
import { renderWithProviders } from '../../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return buildThread({
    id: 'scratch-1',
    projectId: '',
    isScratch: true,
    title: 'Try a regex',
    status: 'pending',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  });
}

describe('ThreadItem', () => {
  test('shows a pending scratch thread as launching instead of ready to launch', () => {
    renderWithProviders(
      <ThreadItem thread={makeThread()} projectPath="" isSelected={false} onSelect={vi.fn()} />,
    );

    expect(screen.getByTestId('thread-item-scratch-1')).toHaveTextContent('Launching...');
    expect(screen.queryByText('Ready to Launch')).not.toBeInTheDocument();
  });

  test('shows the tool a running thread is executing instead of launching', () => {
    useThreadActiveToolStore
      .getState()
      .setActive('scratch-1', { name: 'Bash', input: { command: 'grep -rn sandbox packages' } });
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ status: 'running' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    const row = screen.getByTestId('thread-item-scratch-1');
    expect(row).toHaveTextContent('grep -rn sandbox packages');
    expect(row).not.toHaveTextContent('Launching...');
    act(() => useThreadActiveToolStore.getState().clear('scratch-1'));
  });

  test('renders the pin control beside the thread selection button', () => {
    const { container } = renderWithProviders(
      <ThreadItem
        thread={makeThread({ pinned: true, status: 'idle' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
      />,
    );

    const threadButton = screen.getByTestId('thread-item-scratch-1');
    const pinButton = screen.getByTestId('thread-pin-toggle-scratch-1');

    expect(threadButton).not.toContainElement(pinButton);
    expect(container.querySelector('button button')).not.toBeInTheDocument();
  });

  test('the more-actions menu is reachable by keyboard and labelled', () => {
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ status: 'idle' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    const more = screen.getByTestId('thread-item-more-scratch-1');
    expect(more).not.toHaveAttribute('tabindex', '-1');
    expect(more).toHaveAccessibleName('Thread actions');
    act(() => more.focus());
    expect(more).toHaveFocus();
  });

  test('does not commit a rename while Enter confirms an IME composition', async () => {
    const onRename = vi.fn();
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ status: 'idle' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
        onRename={onRename}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('thread-item-more-scratch-1'), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByTestId('thread-rename-scratch-1'));
    const input = screen.getByTestId('thread-rename-input-scratch-1');
    fireEvent.change(input, { target: { value: 'Renamed thread' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onRename).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
  });

  test('shows git state as an icon instead of the diff-stats chip', () => {
    const gitStatus: GitStatusInfo = {
      threadId: 't-1',
      branchKey: 'p-1:feat/x',
      state: 'dirty',
      dirtyFileCount: 21,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: false,
      isMergedIntoBase: false,
      linesAdded: 1218,
      linesDeleted: 801,
    };
    renderWithProviders(
      <ThreadItem
        thread={makeThread({
          id: 't-1',
          projectId: 'p-1',
          isScratch: false,
          status: 'idle',
          branch: 'feat/x',
        })}
        projectPath="/repo"
        isSelected={false}
        onSelect={vi.fn()}
        gitStatus={gitStatus}
      />,
    );

    expect(screen.getByTestId('thread-git-dirty-t-1')).toHaveTextContent('21');
    expect(screen.queryByText('+1218')).not.toBeInTheDocument();
  });

  test('shows no git state icon for a clean tree', () => {
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ id: 't-2', projectId: 'p-1', isScratch: false, status: 'idle' })}
        projectPath="/repo"
        isSelected={false}
        onSelect={vi.fn()}
        gitStatus={{
          threadId: 't-2',
          branchKey: 'p-1:main',
          state: 'clean',
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 0,
          linesDeleted: 0,
        }}
      />,
    );

    expect(screen.queryByTestId('thread-git-dirty-t-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('thread-git-sync-t-2')).not.toBeInTheDocument();
  });

  test('shows uncommitted files and unpushed commits as separate icons', () => {
    renderWithProviders(
      <ThreadItem
        thread={makeThread({
          id: 't-4',
          projectId: 'p-1',
          isScratch: false,
          status: 'idle',
          branch: 'feat/y',
        })}
        projectPath="/repo"
        isSelected={false}
        onSelect={vi.fn()}
        gitStatus={{
          threadId: 't-4',
          branchKey: 'p-1:feat/y',
          state: 'dirty',
          dirtyFileCount: 2,
          unpushedCommitCount: 3,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 10,
          linesDeleted: 4,
        }}
      />,
    );

    expect(screen.getByTestId('thread-git-dirty-t-4')).toHaveTextContent('2');
    expect(screen.getByTestId('thread-git-sync-t-4')).toHaveTextContent('3');
  });

  test.each([
    ['pushed', { state: 'pushed', hasRemoteBranch: true, isMergedIntoBase: false }],
    ['merged', { state: 'merged', hasRemoteBranch: true, isMergedIntoBase: true }],
  ] as const)('shows no sync icon for a %s branch (the PR badge carries it)', (_, status) => {
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ id: 't-5', projectId: 'p-1', isScratch: false, status: 'idle' })}
        projectPath="/repo"
        isSelected={false}
        onSelect={vi.fn()}
        gitStatus={{
          threadId: 't-5',
          branchKey: 'p-1:feat/z',
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          linesAdded: 0,
          linesDeleted: 0,
          ...status,
        }}
      />,
    );

    expect(screen.queryByTestId('thread-git-sync-t-5')).not.toBeInTheDocument();
  });

  test('shows the PR badge on the title row, not in the powerline', () => {
    renderWithProviders(
      <ThreadItem
        thread={makeThread({
          id: 't-3',
          projectId: 'p-1',
          isScratch: false,
          status: 'idle',
          branch: 'feat/pr',
        })}
        projectPath="/repo"
        subtitle="repo"
        isSelected={false}
        onSelect={vi.fn()}
        gitStatus={{
          threadId: 't-3',
          branchKey: 'p-1:feat/pr',
          state: 'pushed',
          dirtyFileCount: 0,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 0,
          linesDeleted: 0,
          prNumber: 731,
          prState: 'OPEN',
        }}
      />,
    );

    const badge = screen.getByTestId('thread-pr-badge-t-3');
    expect(badge).toHaveTextContent('731');
    expect(screen.getByTestId('thread-powerline-t-3').parentElement).not.toContainElement(badge);
  });

  test('shows a browser icon while the thread has a live browser session', () => {
    useBrowserLiveThreadsStore.setState({ byThread: { 't-4': true } });
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ id: 't-4', projectId: 'p-1', isScratch: false, status: 'idle' })}
        projectPath="/repo"
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('thread-browser-open-t-4')).toBeInTheDocument();

    act(() => useBrowserLiveThreadsStore.getState().markClosed('t-4'));
    expect(screen.queryByTestId('thread-browser-open-t-4')).not.toBeInTheDocument();
  });
  describe('a factory thread whose run works outside the agent', () => {
    const run = (over: Partial<FactoryRun> = {}): FactoryRun =>
      buildFactoryRun({
        issueNumber: 225,
        prUrl: 'https://github.com/o/r/pull/359',
        state: 'waiting_ci',
        currentStep: 'ci',
        threadIds: ['t-factory'],
        startedAt: '2026-11-19T18:00:00.000Z',
        completedAt: null,
        source: 'manual',
        flowSteps: ['implement', 'pull-request', 'ci', 'merge'],
        ...over,
      });
    const seedActiveRuns = (runs: FactoryRun[]) =>
      getDataLayer().queryClient.setQueryData(activeFactoryRunsQuery().queryKey, runs);
    const renderThread = (over: Partial<Thread> = {}) =>
      renderWithProviders(
        <ThreadItem
          thread={makeThread({
            id: 't-factory',
            projectId: 'p1',
            isScratch: false,
            status: 'completed',
            source: 'factory',
            ...over,
          })}
          projectPath="/repo"
          isSelected={false}
          onSelect={vi.fn()}
          onArchive={vi.fn()}
          timeValue="2m"
        />,
      );
    const openMenu = () =>
      fireEvent.pointerDown(screen.getByTestId('thread-item-more-t-factory'), {
        button: 0,
        ctrlKey: false,
      });

    test('shows it busy with the step instead of the time, and offers to stop the run', async () => {
      seedActiveRuns([run()]);
      renderThread();

      expect(screen.getByTestId('thread-factory-activity-t-factory')).toHaveAttribute(
        'data-activity',
        'factory',
      );
      expect(screen.getByText('ci')).toBeInTheDocument();
      expect(screen.queryByText('2m')).not.toBeInTheDocument();

      openMenu();
      expect(await screen.findByTestId('thread-stop-factory-run-t-factory')).toBeInTheDocument();
      expect(screen.queryByText('sidebar.archive')).not.toBeInTheDocument();
    });

    test('a run waiting for the member asks for attention and can be archived', async () => {
      seedActiveRuns([run({ state: 'waiting_human', currentStep: null })]);
      renderThread();

      expect(screen.getByTestId('thread-factory-activity-t-factory')).toHaveAttribute(
        'data-activity',
        'factory-attention',
      );
      openMenu();
      expect(await screen.findByText('sidebar.archive')).toBeInTheDocument();
      expect(screen.queryByTestId('thread-stop-factory-run-t-factory')).not.toBeInTheDocument();
    });

    test('a run whose pipeline stopped on an error shows the error icon and keeps the time', () => {
      seedActiveRuns([run({ state: 'waiting_human', failureReason: 'wait_ci[ci] failed' })]);
      renderThread();

      expect(screen.getByTestId('thread-factory-activity-t-factory')).toHaveAttribute(
        'data-activity',
        'factory-failed',
      );
      expect(screen.getByText('2m')).toBeInTheDocument();
    });

    test('a thread whose agent is running keeps its own status', () => {
      seedActiveRuns([run({ state: 'fixing' })]);
      renderThread({ status: 'running' });
      expect(screen.queryByTestId('thread-factory-activity-t-factory')).not.toBeInTheDocument();
    });

    test('a thread that is not a factory thread never reads the runs', () => {
      seedActiveRuns([run()]);
      renderThread({ source: 'web' });
      expect(screen.queryByTestId('thread-factory-activity-t-factory')).not.toBeInTheDocument();
      expect(screen.getByText('2m')).toBeInTheDocument();
    });
  });
  describe('background activity', () => {
    test('a running job and a pending watcher each show their own icon, right of the title', () => {
      seedBackgroundActivity({
        jobs: [buildJob({ id: 'j1', threadId: 'scratch-1', status: 'running' })],
        watchers: [buildWatcher({ id: 'w1', threadId: 'scratch-1', status: 'pending' })],
      });
      renderWithProviders(
        <ThreadItem
          thread={makeThread({ status: 'idle' })}
          projectPath=""
          isSelected={false}
          onSelect={vi.fn()}
          onPin={vi.fn()}
        />,
      );

      const row = screen.getByTestId('thread-item-scratch-1');
      const job = screen.getByTestId('thread-job-indicator-scratch-1');
      const watcher = screen.getByTestId('thread-watcher-indicator-scratch-1');
      // Inside the title button (after the title), not beside the status pin.
      expect(row).toContainElement(job);
      expect(row).toContainElement(watcher);
      const title = screen.getByText('Try a regex');
      expect(title.compareDocumentPosition(job) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(job.querySelector('svg')?.getAttribute('class')).not.toBe(
        watcher.querySelector('svg')?.getAttribute('class'),
      );
      act(() => seedBackgroundActivity({}));
    });

    test('shows nothing without running jobs or pending watchers', () => {
      seedBackgroundActivity({
        jobs: [buildJob({ id: 'j1', threadId: 'scratch-1', status: 'exited' })],
      });
      renderWithProviders(
        <ThreadItem thread={makeThread()} projectPath="" isSelected={false} onSelect={vi.fn()} />,
      );

      expect(screen.queryByTestId('thread-job-indicator-scratch-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('thread-watcher-indicator-scratch-1')).not.toBeInTheDocument();
      act(() => seedBackgroundActivity({}));
    });
  });
});
