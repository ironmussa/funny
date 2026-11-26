import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

// Window events must go through jsdom (see the helper).
import { mocked, waitFor } from '@funny/test-kit';

const {
  mockNotifyDirty,
  mockFetchProjectBranches,
  mockSetRunnerStatus,
  mockEmitPtyData,
  mockAppendCommandOutput,
  mockMarkCommandExited,
  mockRemoveTab,
  mockDispatchTestEvent,
  mockDispatchBrowserSessionEvent,
  mockStartCommit,
  mockReplaceSteps,
  mockFinishCommit,
  mockSetFailedWorkflow,
  mockActiveCommits,
  mockToastSuccess,
  mockToastError,
  mockShowAgentNotification,
  mockSetTabError,
} = (() => {
  const mockActiveCommits: Record<string, { workflowId?: string }> = {};
  return {
    mockNotifyDirty: vi.fn(),
    mockFetchProjectBranches: vi.fn(),
    mockSetRunnerStatus: vi.fn(),
    mockEmitPtyData: vi.fn(),
    mockAppendCommandOutput: vi.fn(),
    mockMarkCommandExited: vi.fn(),
    mockRemoveTab: vi.fn(),
    mockDispatchTestEvent: vi.fn(),
    mockDispatchBrowserSessionEvent: vi.fn(),
    mockStartCommit: vi.fn(),
    mockReplaceSteps: vi.fn(),
    mockFinishCommit: vi.fn(),
    mockSetFailedWorkflow: vi.fn(),
    mockActiveCommits,
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockShowAgentNotification: vi.fn(),
    mockSetTabError: vi.fn(),
  };
})();

mock.module('@/stores/commit-progress-store', () => ({
  useCommitProgressStore: {
    getState: () => ({
      startCommit: mockStartCommit,
      replaceSteps: mockReplaceSteps,
      finishCommit: mockFinishCommit,
      setFailedWorkflow: mockSetFailedWorkflow,
      activeCommits: mockActiveCommits,
    }),
  },
}));

mock.module('@/stores/review-pane-store', () => ({
  useReviewPaneStore: {
    getState: () => ({ notifyDirty: mockNotifyDirty }),
  },
}));

mock.module('@/data/projects/branches', () => ({
  fetchProjectBranches: mockFetchProjectBranches,
}));

mock.module('@/stores/runner-status-store', () => ({
  useRunnerStatusStore: {
    getState: () => ({ setStatus: mockSetRunnerStatus }),
  },
}));

mock.module('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      emitPtyData: mockEmitPtyData,
      appendCommandOutput: mockAppendCommandOutput,
      markCommandExited: mockMarkCommandExited,
      removeTab: mockRemoveTab,
      setTabError: mockSetTabError,
      updateCommandMetrics: vi.fn(),
    }),
  },
}));

const gitActionOverrides = (() => {
  const overrides: Record<string, (...args: any[]) => unknown> = {};
  return overrides;
})();
const actualDataGitStatusActions = { ...(await import('@/data/git-status/actions')) };
mock.module('@/data/git-status/actions', () => {
  const real = actualDataGitStatusActions;
  const wrapped: Record<string, (...args: any[]) => unknown> = {};
  for (const [name, fn] of Object.entries(real)) {
    wrapped[name] = (...args) => (gitActionOverrides[name] ?? fn)(...args);
  }
  return wrapped;
});

mock.module('@/hooks/dispatch-test-events', () => ({
  dispatchTestEvent: mockDispatchTestEvent,
}));

mock.module('@/hooks/dispatch-browser-session-events', () => ({
  dispatchBrowserSessionEvent: mockDispatchBrowserSessionEvent,
}));

mock.module('@/components/ui/toast', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

mock.module('@/hooks/use-notifications', () => ({
  showAgentNotification: mockShowAgentNotification,
}));

mock.module('@/hooks/use-preview-window', () => ({
  closePreviewForCommand: vi.fn(),
}));

mock.module('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({
      notificationsEnabled: true,
      notificationSoundEnabled: false,
    }),
  },
}));

const actualStoresThreadStoreInternals = { ...(await import('@/stores/thread-store-internals')) };
mock.module('@/stores/thread-store-internals', () => {
  const actual = actualStoresThreadStoreInternals;
  return {
    ...actual,
    getNavigate: () => vi.fn(),
    getProjectIdForThread: vi.fn(() => 'p1'),
  };
});

import { readGitStatusMaps } from '@/data/git-status/read';
import { seedGitStatus } from '@/data/git-status/testing';
import { readThreadIndex } from '@/data/threads/read';
import { buildThread, buildThreadWithMessages, withThreadIndex } from '@/data/threads/testing';
import {
  dispatchRealtimeEvent,
  clearWSDispatchState,
  registerSocketIOHandlers,
  unregisterSocketIOHandlers,
} from '@/hooks/ws-event-dispatch';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { getProjectIdForThread } from '@/stores/thread-store-internals';

import { buildRecordingSocket, buildThreadEvent } from '../helpers/builders-stores';

function captureHandlers() {
  const { socket, handlers } = buildRecordingSocket();
  registerSocketIOHandlers(socket);
  return handlers;
}

describe('ws-event-dispatch — thread/git/terminal events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedGitStatus({
      statusByBranch: {},
      threadToBranchKey: {},
    });
    useProjectStore.setState({ selectedProjectId: null });
  });

  afterEach(() => {
    for (const name of Object.keys(gitActionOverrides)) delete gitActionOverrides[name];
    clearWSDispatchState();
  });

  test('thread:updated applies status, refresh hooks, and permissionMode patch', async () => {
    const statusCalls: Array<{ tid: string; data: unknown }> = [];
    const refreshAll = vi.fn();
    const refreshActive = vi.fn();

    useThreadStore.setState(
      withThreadIndex({
        threadsById: { t1: buildThread({ permissionMode: 'ask' }) },
        threadDataById: { t1: buildThreadWithMessages({ permissionMode: 'ask' }) },
        selectedThreadId: 't1',
        activeThread: buildThreadWithMessages({ permissionMode: 'ask' }),
        handleWSStatus: (tid: string, data: unknown) => {
          statusCalls.push({ tid, data });
        },
        refreshAllLoadedThreads: refreshAll,
        refreshActiveThread: refreshActive,
      }),
    );

    const handlers = captureHandlers();
    handlers['thread:updated']({
      threadId: 't1',
      data: { status: 'completed', branch: 'feat/x', permissionMode: 'plan' },
    });

    expect(statusCalls).toEqual([{ tid: 't1', data: { status: 'completed' } }]);
    expect(refreshAll).toHaveBeenCalled();
    expect(refreshActive).toHaveBeenCalled();
    expect(readThreadIndex().threadsById.t1.permissionMode).toBe('plan');
    expect(useThreadStore.getState().threadDataById.t1.permissionMode).toBe('plan');
    expect(useThreadStore.getState().activeThread?.permissionMode).toBe('plan');
  });

  test('thread:updated archived flag triggers refreshAllLoadedThreads', async () => {
    const refreshAll = vi.fn();
    useThreadStore.setState({
      refreshAllLoadedThreads: refreshAll,
    });

    captureHandlers()['thread:updated']({
      threadId: 't1',
      data: { archived: true },
    });

    expect(refreshAll).toHaveBeenCalled();
  });

  test('thread:updated with a cleared worktree reloads the open thread', () => {
    const refreshAll = vi.fn();
    const refreshActive = vi.fn();
    useThreadStore.setState({
      selectedThreadId: 't1',
      refreshAllLoadedThreads: refreshAll,
      refreshActiveThread: refreshActive,
    });

    // A merged factory run's cleanup removes the worktree: both fields become null.
    captureHandlers()['thread:updated']({
      threadId: 't1',
      data: { worktreePath: null, branch: null },
    });

    expect(refreshAll).toHaveBeenCalled();
    expect(refreshActive).toHaveBeenCalled();
  });

  test('thread:updated resync reloads durable state for the active thread only', () => {
    const refreshActive = vi.fn();
    useThreadStore.setState({
      selectedThreadId: 't1',
      refreshActiveThread: refreshActive,
    });
    const handler = captureHandlers()['thread:updated'];

    handler({ threadId: 't2', data: { resync: true } });
    expect(refreshActive).not.toHaveBeenCalled();

    handler({ threadId: 't1', data: { resync: true } });
    expect(refreshActive).toHaveBeenCalledTimes(1);
  });

  test('thread:stage-changed routes to handleWSStageChanged with mapped data', async () => {
    const stageCalls: Array<{ tid: string; data: unknown }> = [];
    useThreadStore.setState({
      handleWSStageChanged: (tid, data) => {
        stageCalls.push({ tid, data });
      },
    });

    captureHandlers()['thread:stage-changed']({
      threadId: 't1',
      data: { fromStage: 'in_progress', toStage: 'review', projectId: 'p1' },
    });

    expect(stageCalls).toEqual([
      { tid: 't1', data: { fromStage: 'in_progress', toStage: 'review', projectId: 'p1' } },
    ]);
  });

  test('git:status updates git store and marks review pane dirty', async () => {
    const status = {
      threadId: 't1',
      branchKey: 'p1:main',
      state: 'dirty' as const,
      dirtyFileCount: 2,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: false,
      linesAdded: 3,
      linesDeleted: 1,
    };

    captureHandlers()['git:status']({
      threadId: 't1',
      data: { statuses: [status] },
    });

    await waitFor(() => {
      expect(mockNotifyDirty).toHaveBeenCalledWith('t1');
    });

    expect(readGitStatusMaps().statusByBranch['p1:main']).toMatchObject({
      threadId: 't1',
      dirtyFileCount: 2,
    });
    expect(readGitStatusMaps().threadToBranchKey.t1).toBe('p1:main');
  });

  test('git:status with prOnly updates the store without marking review dirty', async () => {
    captureHandlers()['git:status']({
      threadId: 't1',
      data: {
        prOnly: true,
        statuses: [
          {
            threadId: 't1',
            branchKey: 'p1:feature',
            state: 'clean' as const,
            dirtyFileCount: 0,
            unpushedCommitCount: 0,
            unpulledCommitCount: 0,
            hasRemoteBranch: true,
            isMergedIntoBase: false,
            linesAdded: 0,
            linesDeleted: 0,
            prNumber: 42,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(readGitStatusMaps().statusByBranch['p1:feature']).toMatchObject({
        prNumber: 42,
      });
    });
    expect(mockNotifyDirty).not.toHaveBeenCalled();
  });

  test('git:refs-updated only refreshes active slices for the matching project', () => {
    const fetchForThread = vi.fn();
    const fetchProjectStatus = vi.fn();
    const fetchForProject = vi.fn();
    Object.assign(gitActionOverrides, { fetchForThread, fetchProjectStatus, fetchForProject });
    useThreadStore.setState({ selectedThreadId: 't1' });
    useProjectStore.setState({ selectedProjectId: 'p1' });
    mocked(getProjectIdForThread).mockReturnValue('p1');
    const handler = captureHandlers()['git:refs-updated'];

    handler({ threadId: '', data: { projectId: 'p2' } });

    expect(fetchForThread).not.toHaveBeenCalled();
    expect(fetchProjectStatus).not.toHaveBeenCalled();
    expect(fetchForProject).toHaveBeenCalledWith('p2');

    handler({ threadId: '', data: { projectId: 'p1' } });

    expect(fetchForThread).toHaveBeenCalledWith('t1', true);
    expect(fetchProjectStatus).toHaveBeenCalledWith('p1', true);
    expect(fetchForProject).toHaveBeenCalledWith('p1');
  });

  test('git:refs-updated with changed diff refreshes only the review pane', async () => {
    const fetchForThread = vi.fn();
    const fetchProjectStatus = vi.fn();
    const fetchForProject = vi.fn();
    Object.assign(gitActionOverrides, { fetchForThread, fetchProjectStatus, fetchForProject });
    const handler = captureHandlers()['git:refs-updated'];

    // One at a time: concurrent dynamic imports of a mocked module can resolve
    // the second to the real module under vitest.
    handler({ threadId: 't1', data: { projectId: 'p1', changed: ['diff'] } });
    await waitFor(() => expect(mockNotifyDirty).toHaveBeenCalledWith('t1'));
    // Project-mode summaries carry no thread: the pane keys on the project id.
    handler({ threadId: '', data: { projectId: 'p2', changed: ['diff'] } });
    await waitFor(() => expect(mockNotifyDirty).toHaveBeenCalledWith('p2'));
    expect(fetchForThread).not.toHaveBeenCalled();
    expect(fetchProjectStatus).not.toHaveBeenCalled();
    expect(fetchForProject).not.toHaveBeenCalled();
    expect(mockFetchProjectBranches).not.toHaveBeenCalled();
  });

  test('git:refs-updated with changed branches refetches the branch listing', () => {
    const fetchForProject = vi.fn();
    Object.assign(gitActionOverrides, { fetchForProject });
    captureHandlers()['git:refs-updated']({
      threadId: '',
      data: { projectId: 'p1', changed: ['branches'] },
    });

    expect(mockFetchProjectBranches).toHaveBeenCalledWith('p1', { force: true });
    expect(fetchForProject).not.toHaveBeenCalled();
  });

  test('git:refs-updated with changed status refreshes git status slices', () => {
    const fetchForProject = vi.fn();
    Object.assign(gitActionOverrides, { fetchForProject });
    captureHandlers()['git:refs-updated']({
      threadId: '',
      data: { projectId: 'p1', changed: ['status'] },
    });

    expect(fetchForProject).toHaveBeenCalledWith('p1');
  });

  test('thread:created loads project threads when projectId is present', async () => {
    const loadProject = vi.fn();
    useThreadStore.setState({ loadThreadsForProject: loadProject });

    captureHandlers()['thread:created']({
      threadId: 't-new',
      data: { projectId: 'p1' },
    });

    expect(loadProject).toHaveBeenCalledWith('p1');
  });

  test('thread:created ignores scratch threads without projectId', async () => {
    const loadProject = vi.fn();
    useThreadStore.setState({ loadThreadsForProject: loadProject });

    captureHandlers()['thread:created']({
      threadId: 's1',
      data: { projectId: '' },
    });

    expect(loadProject).not.toHaveBeenCalled();
  });

  test('thread:event appends to active thread events without duplicates', async () => {
    useThreadStore.setState({
      activeThread: {
        ...buildThreadWithMessages(),
        threadEvents: [buildThreadEvent({ id: 'ev-1' })],
      },
    });

    captureHandlers()['thread:event']({
      threadId: 't1',
      data: { event: { id: 'ev-2', type: 'status' } },
    });

    await waitFor(() => {
      const events = useThreadStore.getState().activeThread?.threadEvents ?? [];
      expect(events.map((e: { id: string }) => e.id)).toEqual(['ev-1', 'ev-2']);
    });

    captureHandlers()['thread:event']({
      threadId: 't1',
      data: { event: { id: 'ev-2', type: 'status' } },
    });

    await waitFor(() => {
      const events = useThreadStore.getState().activeThread?.threadEvents ?? [];
      expect(events).toHaveLength(2);
    });
  });

  test('worktree:setup and worktree:setup_complete route to thread store handlers', async () => {
    const setupCalls: unknown[] = [];
    const completeCalls: unknown[] = [];
    useThreadStore.setState({
      handleWSWorktreeSetup: (tid, data) => {
        setupCalls.push({ tid, data });
      },
      handleWSWorktreeSetupComplete: (tid, data) => {
        completeCalls.push({ tid, data });
      },
    });

    const handlers = captureHandlers();
    handlers['worktree:setup']({
      threadId: 't1',
      data: { step: 'clone', label: 'Cloning', status: 'running' },
    });
    handlers['worktree:setup_complete']({
      threadId: 't1',
      data: { ok: true },
    });

    expect(setupCalls).toHaveLength(1);
    expect(completeCalls).toEqual([{ tid: 't1', data: { ok: true } }]);
  });

  test('runner:status updates runner status store for online/offline', async () => {
    captureHandlers()['runner:status']({ threadId: '', data: { status: 'online' } });
    await waitFor(() => {
      expect(mockSetRunnerStatus).toHaveBeenCalledWith('online');
    });

    mockSetRunnerStatus.mockClear();
    captureHandlers()['runner:status']({ threadId: '', data: { status: 'offline' } });
    await waitFor(() => {
      expect(mockSetRunnerStatus).toHaveBeenCalledWith('offline');
    });
  });

  test('command and pty events route to terminal store', async () => {
    const handlers = captureHandlers();

    handlers['command:output']({
      threadId: 't1',
      data: { commandId: 'cmd-1', data: 'hello\n' },
    });
    handlers['command:status']({
      threadId: 't1',
      data: { commandId: 'cmd-1', status: 'exited' },
    });
    handlers['pty:data']({
      threadId: 't1',
      data: { ptyId: 'pty-1', data: 'prompt$ ' },
    });
    handlers['pty:exit']({
      threadId: 't1',
      data: { ptyId: 'pty-1' },
    });

    expect(mockAppendCommandOutput).toHaveBeenCalledWith('cmd-1', 'hello\n');
    expect(mockMarkCommandExited).toHaveBeenCalledWith('cmd-1');
    expect(mockEmitPtyData).toHaveBeenCalledWith('pty-1', 'prompt$ ');
    expect(mockRemoveTab).toHaveBeenCalledWith('pty-1');
  });

  test('thread:comment_deleted refreshes active thread when ids match', async () => {
    const refreshActive = vi.fn();
    useThreadStore.setState({
      activeThread: buildThreadWithMessages(),
      refreshActiveThread: refreshActive,
    });

    captureHandlers()['thread:comment_deleted']({ threadId: 't1', data: {} });
    expect(refreshActive).toHaveBeenCalled();
  });

  test('test and browser-session events delegate to dispatch helpers', async () => {
    const handlers = captureHandlers();

    handlers['test:output']({ threadId: 't1', data: { line: 'ok' } });
    dispatchRealtimeEvent('browser-session:frame', '', { frame: 1 });

    expect(mockDispatchTestEvent).toHaveBeenCalledWith('test:output', { line: 'ok' });
    expect(mockDispatchBrowserSessionEvent).toHaveBeenCalledWith('browser-session:frame', {
      frame: 1,
    });
  });

  test('browser-session events have no Socket.IO handler (browser.v1 only)', () => {
    const handlers = captureHandlers();
    expect(Object.keys(handlers).filter((type) => type.startsWith('browser-session:'))).toEqual([]);
  });

  test('clone:progress dispatches a window CustomEvent', async () => {
    const listener = vi.fn();
    window.addEventListener('clone:progress', listener);

    captureHandlers()['clone:progress']({
      threadId: 't1',
      data: { pct: 50 },
    });

    expect(listener).toHaveBeenCalled();
    window.removeEventListener('clone:progress', listener);
  });

  test('git:workflow_progress starts commit progress on started status', async () => {
    captureHandlers()['git:workflow_progress']({
      threadId: 't1',
      data: {
        status: 'started',
        title: 'Committing',
        action: 'commit',
        workflowId: 'wf-1',
        steps: [{ id: 'stage', label: 'Stage', status: 'running' }],
      },
    });

    await waitFor(() => {
      expect(mockStartCommit).toHaveBeenCalledWith(
        't1',
        'Committing',
        [{ id: 'stage', label: 'Stage', status: 'running' }],
        'commit',
        'wf-1',
      );
    });
  });

  test('git:workflow_progress shows hook failure toast on step_update', async () => {
    captureHandlers()['git:workflow_progress']({
      threadId: 't1',
      data: {
        status: 'step_update',
        steps: [{ id: 'hooks', status: 'failed', error: 'lint failed badly' }],
      },
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Pre-commit hook failed',
        expect.objectContaining({ description: 'lint failed badly' }),
      );
    });
  });

  test('pty:env_activated shows success toast with activation lines', () => {
    captureHandlers()['pty:env_activated']({
      threadId: 't1',
      data: {
        activations: [
          { kind: 'venv', detail: 'python3.12' },
          { kind: 'nvm', detail: 'node 20' },
        ],
      },
    });

    expect(mockToastSuccess).toHaveBeenCalledWith('Activated environment', {
      description: 'venv: python3.12\nnvm: node 20',
    });
  });

  test('pty:error sets tab error and shows toast', () => {
    captureHandlers()['pty:error']({
      threadId: 't1',
      data: { ptyId: 'pty-1', error: 'spawn failed' },
    });

    expect(mockSetTabError).toHaveBeenCalledWith('pty-1', 'spawn failed');
    expect(mockToastError).toHaveBeenCalledWith('spawn failed');
  });

  test('git:workflow_progress completes push workflow and marks review dirty', async () => {
    vi.useFakeTimers();
    captureHandlers()['git:workflow_progress']({
      threadId: 't1',
      data: {
        status: 'completed',
        action: 'push',
        steps: [{ id: 'push', status: 'done' }],
      },
    });

    await waitFor(() => {
      expect(mockReplaceSteps).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Pushed successfully');
    });
    await waitFor(() => {
      expect(mockNotifyDirty).toHaveBeenCalledWith('t1');
    });

    vi.advanceTimersByTime(1500);
    expect(mockFinishCommit).toHaveBeenCalledWith('t1', undefined, 'push');
    vi.useRealTimers();
  });

  test('git:workflow_progress restart cancels the previous workflow close timer', async () => {
    vi.useFakeTimers();
    const handler = captureHandlers()['git:workflow_progress'];
    handler({
      threadId: 't1',
      data: { status: 'completed', action: 'commit', workflowId: 'wf-1', steps: [] },
    });
    await waitFor(() => expect(mockReplaceSteps).toHaveBeenCalled());

    handler({
      threadId: 't1',
      data: { status: 'started', title: 'Again', action: 'commit', workflowId: 'wf-2', steps: [] },
    });
    await waitFor(() => expect(mockStartCommit).toHaveBeenCalled());

    vi.advanceTimersByTime(1500);
    expect(mockFinishCommit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('git:workflow_progress records failed workflow state', async () => {
    captureHandlers()['git:workflow_progress']({
      threadId: 't1',
      data: {
        status: 'failed',
        title: 'Push failed',
        action: 'push',
        steps: [{ id: 'push', status: 'failed' }],
      },
    });

    await waitFor(() => {
      expect(mockSetFailedWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Push failed', action: 'push' }),
      );
      expect(mockFinishCommit).toHaveBeenCalledWith('t1', undefined, 'push');
    });
  });

  test('git:workflow_progress takes a new run’s setup failure during the previous run’s close delay', async () => {
    vi.useFakeTimers();
    try {
      // Run A completes: its entry stays on screen for the close delay.
      captureHandlers()['git:workflow_progress']({
        threadId: 't1',
        data: { status: 'completed', action: 'push', workflowId: 'wf-a', steps: [] },
      });
      await waitFor(() => expect(mockReplaceSteps).toHaveBeenCalled());
      mockActiveCommits.t1 = { workflowId: 'wf-a' };

      // Run B fails during setup: `failed` without `started`.
      captureHandlers()['git:workflow_progress']({
        threadId: 't1',
        data: {
          status: 'failed',
          title: 'Commit failed',
          action: 'commit',
          workflowId: 'wf-b',
          steps: [],
        },
      });
      await waitFor(() =>
        expect(mockSetFailedWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Commit failed' }),
        ),
      );
      // A's entry is ended at once rather than by its delayed close.
      expect(mockFinishCommit).toHaveBeenCalledWith('t1', 'wf-a');
      vi.advanceTimersByTime(5000);
      expect(mockFinishCommit).not.toHaveBeenCalledWith('t1', 'wf-a', 'push');
    } finally {
      delete mockActiveCommits.t1;
      vi.useRealTimers();
    }
  });

  test('git:workflow_progress ignores a terminal event of an earlier run', async () => {
    mockActiveCommits.t1 = { workflowId: 'wf-2' };
    try {
      captureHandlers()['git:workflow_progress']({
        threadId: 't1',
        data: {
          status: 'failed',
          title: 'Push failed',
          action: 'push',
          workflowId: 'wf-1',
          steps: [{ id: 'push', status: 'failed' }],
        },
      });
      // Let the dynamic store import settle, then check nothing was touched.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockSetFailedWorkflow).not.toHaveBeenCalled();
      expect(mockReplaceSteps).not.toHaveBeenCalled();
      expect(mockFinishCommit).not.toHaveBeenCalled();
    } finally {
      delete mockActiveCommits.t1;
    }
  });

  test('agent:result dispatches desktop notification when tab is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(function NotificationMock() {}, { permission: 'granted' }),
    });

    useThreadStore.setState(
      withThreadIndex({
        activeThread: buildThreadWithMessages({ title: 'Fix bug', branch: 'feat/x' }),
        threadsById: { t1: buildThread({ title: 'Fix bug', branch: 'feat/x' }) },
      }),
    );

    captureHandlers()['agent:result']({
      threadId: 't1',
      data: { status: 'completed', cost: 0.01, duration: 2 },
    });

    await waitFor(() => {
      expect(mockShowAgentNotification).toHaveBeenCalledWith(
        expect.stringContaining('Fix bug'),
        'Agent finished',
        expect.objectContaining({ tag: 'agent-result-t1' }),
      );
    });
  });

  test('unregisterSocketIOHandlers detaches captured handlers', () => {
    const { socket, onCalls, offCalls } = buildRecordingSocket();
    registerSocketIOHandlers(socket);
    expect(onCalls.length).toBeGreaterThan(0);

    unregisterSocketIOHandlers(socket);
    expect(offCalls.length).toBeGreaterThan(0);
  });
});
