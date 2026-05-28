import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  mockNotifyDirty,
  mockSetRunnerStatus,
  mockEmitPtyData,
  mockAppendCommandOutput,
  mockMarkCommandExited,
  mockRemoveTab,
  mockDispatchTestEvent,
  mockDispatchBrowserSessionEvent,
} = vi.hoisted(() => ({
  mockNotifyDirty: vi.fn(),
  mockSetRunnerStatus: vi.fn(),
  mockEmitPtyData: vi.fn(),
  mockAppendCommandOutput: vi.fn(),
  mockMarkCommandExited: vi.fn(),
  mockRemoveTab: vi.fn(),
  mockDispatchTestEvent: vi.fn(),
  mockDispatchBrowserSessionEvent: vi.fn(),
}));

vi.mock('@/stores/review-pane-store', () => ({
  useReviewPaneStore: {
    getState: () => ({ notifyDirty: mockNotifyDirty }),
  },
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
      setTabError: vi.fn(),
      updateCommandMetrics: vi.fn(),
    }),
  },
}));

vi.mock('@/hooks/dispatch-test-events', () => ({
  dispatchTestEvent: mockDispatchTestEvent,
}));

vi.mock('@/hooks/dispatch-browser-session-events', () => ({
  dispatchBrowserSessionEvent: mockDispatchBrowserSessionEvent,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/use-notifications', () => ({
  showAgentNotification: vi.fn(),
}));

vi.mock('@/hooks/use-preview-window', () => ({
  closePreviewForCommand: vi.fn(),
}));

import { clearWSDispatchState, registerSocketIOHandlers } from '@/hooks/ws-event-dispatch';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useThreadStore } from '@/stores/thread-store';

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
    useGitStatusStore.setState({
      statusByBranch: {},
      threadToBranchKey: {},
      fetchingKeys: new Set(),
      cooldownUntil: {},
    });
  });

  afterEach(() => {
    clearWSDispatchState();
  });

  test('thread:updated applies status, refresh hooks, and permissionMode patch', async () => {
    const statusCalls: Array<{ tid: string; data: unknown }> = [];
    const refreshAll = vi.fn();
    const refreshActive = vi.fn();

    useThreadStore.setState({
      activeThread: { id: 't1', permissionMode: 'default' } as any,
      handleWSStatus: ((tid: string, data: unknown) => {
        statusCalls.push({ tid, data });
      }) as any,
      refreshAllLoadedThreads: refreshAll as any,
      refreshActiveThread: refreshActive as any,
    });

    const handlers = captureHandlers();
    handlers['thread:updated']({
      threadId: 't1',
      data: { status: 'completed', branch: 'feat/x', permissionMode: 'plan' },
    });

    expect(statusCalls).toEqual([{ tid: 't1', data: { status: 'completed' } }]);
    expect(refreshAll).toHaveBeenCalled();
    expect(refreshActive).toHaveBeenCalled();
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

    expect(useGitStatusStore.getState().statusByBranch['p1:main']).toMatchObject({
      threadId: 't1',
      dirtyFileCount: 2,
    });
    expect(useGitStatusStore.getState().threadToBranchKey.t1).toBe('p1:main');
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
    handlers['browser-session:frame']({ threadId: 't1', data: { frame: 1 } });

    expect(mockDispatchTestEvent).toHaveBeenCalledWith('test:output', { line: 'ok' });
    expect(mockDispatchBrowserSessionEvent).toHaveBeenCalledWith('browser-session:frame', {
      frame: 1,
    });
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
});
