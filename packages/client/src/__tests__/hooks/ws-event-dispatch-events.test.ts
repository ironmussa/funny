import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  mockToastSuccess,
  mockToastError,
  mockShowAgentNotification,
  mockSetTabError,
} = vi.hoisted(() => ({
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
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockShowAgentNotification: vi.fn(),
  mockSetTabError: vi.fn(),
}));

vi.mock('@/stores/commit-progress-store', () => ({
  useCommitProgressStore: {
    getState: () => ({
      startCommit: mockStartCommit,
      replaceSteps: mockReplaceSteps,
      finishCommit: mockFinishCommit,
      setFailedWorkflow: mockSetFailedWorkflow,
    }),
  },
}));

vi.mock('@/stores/review-pane-store', () => ({
  useReviewPaneStore: {
    getState: () => ({ notifyDirty: mockNotifyDirty }),
  },
}));

vi.mock('@/data/projects/branches', () => ({
  fetchProjectBranches: mockFetchProjectBranches,
}));

vi.mock('@/stores/runner-status-store', () => ({
  useRunnerStatusStore: {
    getState: () => ({ setStatus: mockSetRunnerStatus }),
  },
}));

vi.mock('@/stores/terminal-store', () => ({
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

const gitActionOverrides = vi.hoisted(() => ({}) as Record<string, (...args: any[]) => unknown>);
vi.mock('@/data/git-status/actions', async (importOriginal) => {
  const real = await importOriginal<Record<string, (...args: any[]) => unknown>>();
  const wrapped: Record<string, (...args: any[]) => unknown> = {};
  for (const [name, fn] of Object.entries(real)) {
    wrapped[name] = (...args) => (gitActionOverrides[name] ?? fn)(...args);
  }
  return wrapped;
});

vi.mock('@/hooks/dispatch-test-events', () => ({
  dispatchTestEvent: mockDispatchTestEvent,
}));

vi.mock('@/hooks/dispatch-browser-session-events', () => ({
  dispatchBrowserSessionEvent: mockDispatchBrowserSessionEvent,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

vi.mock('@/hooks/use-notifications', () => ({
  showAgentNotification: mockShowAgentNotification,
}));

vi.mock('@/hooks/use-preview-window', () => ({
  closePreviewForCommand: vi.fn(),
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({
      notificationsEnabled: true,
      notificationSoundEnabled: false,
    }),
  },
}));

vi.mock('@/stores/thread-store-internals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/thread-store-internals')>();
  return {
    ...actual,
    getNavigate: () => vi.fn(),
    getProjectIdForThread: vi.fn(() => 'p1'),
  };
});

import { readGitStatusMaps } from '@/data/git-status/read';
import { seedGitStatus } from '@/data/git-status/testing';
import { readThreadIndex } from '@/data/threads/read';
import { withThreadIndex } from '@/data/threads/testing';
import {
  dispatchRealtimeEvent,
  clearWSDispatchState,
  registerSocketIOHandlers,
  unregisterSocketIOHandlers,
} from '@/hooks/ws-event-dispatch';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { getProjectIdForThread } from '@/stores/thread-store-internals';

function captureHandlers() {
  const handlers: Record<string, (e: any) => void> = {};
  registerSocketIOHandlers({
    on(event: string, handler: (e: any) => void) {
      handlers[event] = handler;
    },
  } as any);
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
        threadsById: { t1: { id: 't1', permissionMode: 'ask' } } as any,
        threadDataById: { t1: { id: 't1', permissionMode: 'ask' } } as any,
        selectedThreadId: 't1',
        activeThread: { id: 't1', permissionMode: 'ask' } as any,
        handleWSStatus: ((tid: string, data: unknown) => {
          statusCalls.push({ tid, data });
        }) as any,
        refreshAllLoadedThreads: refreshAll as any,
        refreshActiveThread: refreshActive as any,
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
      refreshAllLoadedThreads: refreshAll as any,
    });

    captureHandlers()['thread:updated']({
      threadId: 't1',
      data: { archived: true },
    });

    expect(refreshAll).toHaveBeenCalled();
  });

  test('thread:updated resync reloads durable state for the active thread only', () => {
    const refreshActive = vi.fn();
    useThreadStore.setState({
      selectedThreadId: 't1',
      refreshActiveThread: refreshActive as any,
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
      handleWSStageChanged: ((tid: string, data: unknown) => {
        stageCalls.push({ tid, data });
      }) as any,
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

    await vi.waitFor(() => {
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

    await vi.waitFor(() => {
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
    vi.mocked(getProjectIdForThread).mockReturnValue('p1');
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
    await vi.waitFor(() => expect(mockNotifyDirty).toHaveBeenCalledWith('t1'));
    // Project-mode summaries carry no thread: the pane keys on the project id.
    handler({ threadId: '', data: { projectId: 'p2', changed: ['diff'] } });
    await vi.waitFor(() => expect(mockNotifyDirty).toHaveBeenCalledWith('p2'));
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
    useThreadStore.setState({ loadThreadsForProject: loadProject as any });

    captureHandlers()['thread:created']({
      threadId: 't-new',
      data: { projectId: 'p1' },
    });

    expect(loadProject).toHaveBeenCalledWith('p1');
  });

  test('thread:created ignores scratch threads without projectId', async () => {
    const loadProject = vi.fn();
    useThreadStore.setState({ loadThreadsForProject: loadProject as any });

    captureHandlers()['thread:created']({
      threadId: 's1',
      data: { projectId: '' },
    });

    expect(loadProject).not.toHaveBeenCalled();
  });

  test('thread:event appends to active thread events without duplicates', async () => {
    useThreadStore.setState({
      activeThread: {
        id: 't1',
        threadEvents: [{ id: 'ev-1', type: 'note' }],
      } as any,
    });

    captureHandlers()['thread:event']({
      threadId: 't1',
      data: { event: { id: 'ev-2', type: 'status' } },
    });

    await vi.waitFor(() => {
      const events = useThreadStore.getState().activeThread?.threadEvents ?? [];
      expect(events.map((e: { id: string }) => e.id)).toEqual(['ev-1', 'ev-2']);
    });

    captureHandlers()['thread:event']({
      threadId: 't1',
      data: { event: { id: 'ev-2', type: 'status' } },
    });

    await vi.waitFor(() => {
      const events = useThreadStore.getState().activeThread?.threadEvents ?? [];
      expect(events).toHaveLength(2);
    });
  });

  test('worktree:setup and worktree:setup_complete route to thread store handlers', async () => {
    const setupCalls: unknown[] = [];
    const completeCalls: unknown[] = [];
    useThreadStore.setState({
      handleWSWorktreeSetup: ((tid: string, data: unknown) => {
        setupCalls.push({ tid, data });
      }) as any,
      handleWSWorktreeSetupComplete: ((tid: string, data: unknown) => {
        completeCalls.push({ tid, data });
      }) as any,
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
    await vi.waitFor(() => {
      expect(mockSetRunnerStatus).toHaveBeenCalledWith('online');
    });

    mockSetRunnerStatus.mockClear();
    captureHandlers()['runner:status']({ threadId: '', data: { status: 'offline' } });
    await vi.waitFor(() => {
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
      activeThread: { id: 't1' } as any,
      refreshActiveThread: refreshActive as any,
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
    window.addEventListener('clone:progress', listener as EventListener);

    captureHandlers()['clone:progress']({
      threadId: 't1',
      data: { pct: 50 },
    });

    expect(listener).toHaveBeenCalled();
    window.removeEventListener('clone:progress', listener as EventListener);
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

    await vi.waitFor(() => {
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

    await vi.waitFor(() => {
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

    await vi.waitFor(() => {
      expect(mockReplaceSteps).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Pushed successfully');
    });
    await vi.waitFor(() => {
      expect(mockNotifyDirty).toHaveBeenCalledWith('t1');
    });

    vi.advanceTimersByTime(1500);
    expect(mockFinishCommit).toHaveBeenCalledWith('t1', undefined);
    vi.useRealTimers();
  });

  test('git:workflow_progress restart cancels the previous workflow close timer', async () => {
    vi.useFakeTimers();
    const handler = captureHandlers()['git:workflow_progress'];
    handler({
      threadId: 't1',
      data: { status: 'completed', action: 'commit', workflowId: 'wf-1', steps: [] },
    });
    await vi.waitFor(() => expect(mockReplaceSteps).toHaveBeenCalled());

    handler({
      threadId: 't1',
      data: { status: 'started', title: 'Again', action: 'commit', workflowId: 'wf-2', steps: [] },
    });
    await vi.waitFor(() => expect(mockStartCommit).toHaveBeenCalled());

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

    await vi.waitFor(() => {
      expect(mockSetFailedWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Push failed', action: 'push' }),
      );
      expect(mockFinishCommit).toHaveBeenCalledWith('t1', undefined);
    });
  });

  test('agent:result dispatches desktop notification when tab is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(function NotificationMock() {}, { permission: 'granted' }),
    });

    useThreadStore.setState(
      withThreadIndex({
        activeThread: {
          id: 't1',
          projectId: 'p1',
          title: 'Fix bug',
          branch: 'feat/x',
        } as any,
        threadsById: {
          t1: { id: 't1', projectId: 'p1', title: 'Fix bug', branch: 'feat/x' } as any,
        },
      }),
    );

    captureHandlers()['agent:result']({
      threadId: 't1',
      data: { status: 'completed', cost: 0.01, duration: 2 },
    });

    await vi.waitFor(() => {
      expect(mockShowAgentNotification).toHaveBeenCalledWith(
        expect.stringContaining('Fix bug'),
        'Agent finished',
        expect.objectContaining({ tag: 'agent-result-t1' }),
      );
    });
  });

  test('unregisterSocketIOHandlers detaches captured handlers', () => {
    const off = vi.fn();
    const socket = {
      on: vi.fn(),
      off,
    } as any;
    registerSocketIOHandlers(socket);
    expect(socket.on).toHaveBeenCalled();

    unregisterSocketIOHandlers(socket);
    expect(off).toHaveBeenCalled();
  });
});
