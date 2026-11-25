import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { ContextBreakdown } from '@funny/shared';
import { mocked } from '@funny/test-kit';

import { getContextUsageStore } from '@/data/context-usage/store';
import { seedContextUsage } from '@/data/context-usage/testing';
import {
  attachThreadIndex,
  buildThreadWithMessages,
  type ThreadIndexFields,
} from '@/data/threads/testing';
import { loadContextUsage, saveContextUsage } from '@/lib/context-usage-storage';

const { mockInvalidate, mockBuffer, mockMarkRead, mockToastError } = (() => ({
  mockInvalidate: vi.fn(),
  mockBuffer: vi.fn(),
  mockMarkRead: vi.fn(),
  mockToastError: vi.fn(),
}))();

const mockWsEventToMachine = (() =>
  // Returns null for an event the machine does not know, like the real mapper.
  vi.fn((_kind: string, data: any): { type: string; status: string } | null => ({
    type: 'SET_STATUS',
    status: data.status,
  })))();

mock.module('@/stores/thread-machine-bridge', () => ({
  invalidateThreadData: mockInvalidate,
  transitionThreadStatus: vi.fn(
    (_id: string, evt: { status?: string }, current: string) => evt.status ?? current,
  ),
  wsEventToMachineEvent: mockWsEventToMachine,
}));

mock.module('@/stores/thread-read-store', () => ({
  useThreadReadStore: { getState: () => ({ markRead: mockMarkRead }) },
}));

mock.module('@/stores/thread-store-internals', () => ({
  bufferWSEvent: mockBuffer,
  getNavigate: vi.fn(() => vi.fn()),
  getProjectIdForThread: vi.fn(() => null),
  // null → routing gates fall back to the passed state's selectedThreadId.
  getUrlThreadId: () => null,
  setUrlThreadId: vi.fn(),
}));

mock.module('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: mockToastError,
    dismiss: vi.fn(),
  },
}));

const {
  handleWSStatus,
  handleWSError,
  handleWSContextUsage,
  handleWSResult,
  handleWSStageChanged,
} = await import('@/stores/thread-ws-handlers');
import { toast } from 'sonner';

import { useSidebarFilterStore } from '@/stores/sidebar-filter-store';

const THREAD_ID = 'thread-edge';

/**
 * The plain-object store the handlers drive: the thread index fields (seeded
 * into the data layer) plus loosely shaped store fields the tests override.
 */
interface HandlerTestState extends ThreadIndexFields {
  [field: string]: any;
}

function makeState(overrides: HandlerTestState = {}) {
  const activeThread = buildThreadWithMessages({
    id: THREAD_ID,
    title: 'Edge case',
    status: 'running',
  });
  const merged: HandlerTestState = {
    threadsById: { [THREAD_ID]: activeThread },
    threadIdsByProject: { p1: [THREAD_ID] },
    scratchThreadIds: [],
    threadTotalByProject: { p1: 1 },
    scratchThreadTotal: 0,
    selectedThreadId: THREAD_ID,
    threadDataById: { [THREAD_ID]: activeThread },
    activeThread,
    setupProgressByThread: {},
    loadThreadsForProject: vi.fn(),
    ...overrides,
  };
  const {
    threadsById,
    threadIdsByProject,
    scratchThreadIds,
    sharedThreadIds,
    threadTotalByProject,
    scratchThreadTotal,
    sharedThreadTotal,
    ...rest
  } = merged;
  // Thread rows and lists live in the data layer: seed them there and expose
  // them on the plain state as live getters, so assertions read handler writes.
  return attachThreadIndex(rest, {
    threadsById,
    threadIdsByProject,
    scratchThreadIds,
    sharedThreadIds,
    threadTotalByProject,
    scratchThreadTotal,
    sharedThreadTotal,
  });
}

function makeGetSet(state: any) {
  const get = () => state;
  const set = (partial: any) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    Object.assign(state, next);
  };
  return { get, set };
}

describe('thread-ws-handlers — error, context, and refresh edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWsEventToMachine.mockImplementation((_kind: string, data: any) => ({
      type: 'SET_STATUS',
      status: data.status,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('handleWSError sets failed status, resultInfo, and shows toast', () => {
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSError(get, set, THREAD_ID, { error: 'Something broke' });

    expect(state.threadDataById[THREAD_ID].status).toBe('failed');
    expect(state.threadDataById[THREAD_ID].resultInfo).toMatchObject({
      status: 'failed',
      error: 'Something broke',
    });
    expect(mockToastError).toHaveBeenCalledWith('Something broke', { duration: 8000 });
  });

  test('handleWSError humanizes network errors in toast', () => {
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSError(get, set, THREAD_ID, { error: 'fetch failed: ETIMEDOUT' });

    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringMatching(/timed out|Connection lost/i),
      { duration: 8000 },
    );
  });

  test('handleWSStatus applies waiting state with permission request', () => {
    const state = makeState({ activeThread: { ...makeState().activeThread, status: 'running' } });
    state.threadsById[THREAD_ID].status = 'running';
    state.threadDataById[THREAD_ID].status = 'running';
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, {
      status: 'waiting',
      waitingReason: 'tool_approval',
      permissionRequest: { toolName: 'Bash', toolInput: '{"command":"ls"}' },
    });

    expect(state.threadDataById[THREAD_ID].status).toBe('waiting');
    expect(state.threadDataById[THREAD_ID].waitingReason).toBe('tool_approval');
    expect(state.threadDataById[THREAD_ID].pendingPermission?.toolName).toBe('Bash');
  });

  test('clears a previous Codex capability when starting a run without one', () => {
    const state = makeState();
    state.threadDataById[THREAD_ID].status = 'completed';
    state.threadDataById[THREAD_ID].permissionApprovalCapability = {
      kind: 'unavailable',
      reason: 'codex-sdk-no-interactive-approval',
    };
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'running' });
    handleWSStatus(get, set, THREAD_ID, {
      status: 'waiting',
      waitingReason: 'provider_error',
    });

    expect(state.threadDataById[THREAD_ID].permissionApprovalCapability).toBeUndefined();
    expect(state.threadDataById[THREAD_ID].waitingReason).toBe('provider_error');
  });

  test('retains the current run capability through status updates and permission waits', () => {
    const state = makeState();
    state.threadDataById[THREAD_ID].status = 'completed';
    const { get, set } = makeGetSet(state);
    const capability = {
      kind: 'unavailable' as const,
      reason: 'codex-sdk-no-interactive-approval' as const,
    };

    handleWSStatus(get, set, THREAD_ID, {
      status: 'running',
      permissionApprovalCapability: capability,
    });
    handleWSStatus(get, set, THREAD_ID, { status: 'running', stage: 'in_progress' });
    handleWSStatus(get, set, THREAD_ID, { status: 'waiting', waitingReason: 'permission' });

    expect(state.threadDataById[THREAD_ID].permissionApprovalCapability).toEqual(capability);
  });

  test('a status from the server settles an optimistic send: nothing is left to undo', async () => {
    const { rememberPreSendState, takePreSendState } =
      await import('@/stores/optimistic-run-state');
    const state = makeState();
    const { get, set } = makeGetSet(state);

    rememberPreSendState(THREAD_ID, { status: 'completed' });
    handleWSStatus(get, set, THREAD_ID, { status: 'running' });

    expect(takePreSendState(THREAD_ID)).toBeUndefined();
  });

  test('handleWSStatus stopped marks the open thread read at its new completedAt', () => {
    // A stop ends the run with `agent:status` alone (no `agent:result`). The
    // open thread must not turn unread, or the blue unread dot hides the
    // stopped dot in the sidebar.
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'stopped' });

    const completedAt = state.threadsById[THREAD_ID].completedAt;
    expect(state.threadsById[THREAD_ID].status).toBe('stopped');
    expect(completedAt).toBeString();
    expect(mockMarkRead).toHaveBeenCalledWith(THREAD_ID, completedAt);
  });

  test('handleWSStatus stopped leaves a thread the user is not viewing unread', () => {
    const state = makeState({ selectedThreadId: 'other-thread' });
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'stopped' });

    expect(state.threadsById[THREAD_ID].status).toBe('stopped');
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  test('handleWSStatus no-ops when machine event is invalid', () => {
    mockWsEventToMachine.mockReturnValueOnce(null);
    const state = makeState();
    state.threadsById[THREAD_ID].status = 'idle';
    state.threadDataById[THREAD_ID].status = 'idle';
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'running' });

    expect(state.threadsById[THREAD_ID].status).toBe('idle');
    expect(state.threadDataById[THREAD_ID].status).toBe('idle');
  });

  test('handleWSContextUsage writes and persists usage without buffering for hydration', () => {
    seedContextUsage({});

    handleWSContextUsage(THREAD_ID, {
      inputTokens: 10,
      outputTokens: 5,
      cumulativeInputTokens: 100,
    });

    const expected = { cumulativeInputTokens: 100, lastInputTokens: 10, lastOutputTokens: 5 };
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(getContextUsageStore().read(THREAD_ID)).toMatchObject(expected);
    // Persisted so the ring survives a reload (the runtime keeps usage in memory only).
    expect(loadContextUsage(THREAD_ID)).toEqual(expected);
  });

  test('handleWSContextUsage keeps the saved breakdown when a running thread reports before it is selected', () => {
    // A fresh tab: nothing in the session, last turn's snapshot in storage.
    const breakdown: ContextBreakdown = {
      totalTokens: 90_000,
      maxTokens: 1_000_000,
      percentage: 9,
      model: 'claude-opus-5-5',
      categories: [{ id: 'messages', name: 'Messages', tokens: 90_000, kind: 'used' }],
      mcpServers: [],
      memoryFiles: [],
      capturedAt: '2026-11-21T08:48:58.000Z',
    };
    seedContextUsage({});
    saveContextUsage(THREAD_ID, {
      cumulativeInputTokens: 90_000,
      lastInputTokens: 90_000,
      lastOutputTokens: 0,
      breakdown,
    });

    // The running turn's per-message event carries no breakdown.
    handleWSContextUsage(THREAD_ID, {
      inputTokens: 114_000,
      outputTokens: 20,
      cumulativeInputTokens: 114_000,
    });

    expect(getContextUsageStore().read(THREAD_ID)?.breakdown).toEqual(breakdown);
    expect(loadContextUsage(THREAD_ID)?.breakdown).toEqual(breakdown);
    expect(loadContextUsage(THREAD_ID)?.cumulativeInputTokens).toBe(114_000);
  });

  test('handleWSStatus schedules project refresh for unknown sidebar thread', async () => {
    vi.useFakeTimers();
    const loadThreads = vi.fn();
    const payloadOnly = {
      id: 'external-1',
      projectId: 'p2',
      title: 'External',
      status: 'running',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      threadsById: {},
      threadIdsByProject: { p2: ['other'] },
      threadDataById: { 'external-1': payloadOnly },
      selectedThreadId: 'external-1',
      activeThread: payloadOnly,
      loadThreadsForProject: loadThreads,
    });
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, 'external-1', { status: 'completed' });

    vi.advanceTimersByTime(2000);
    expect(loadThreads).toHaveBeenCalledWith('p2');
  });

  test('handleWSResult marks active thread read and notifies on scratch completion', () => {
    const scratchThread = buildThreadWithMessages({
      id: 'scratch-x',
      projectId: '',
      isScratch: true,
      title: 'Quick idea',
      status: 'running',
    });
    const state = makeState({
      selectedThreadId: 'scratch-x',
      activeThread: scratchThread,
      threadsById: { 'scratch-x': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-x'],
      threadDataById: { 'scratch-x': scratchThread },
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, 'scratch-x', { status: 'completed', cost: 0.01, duration: 3 });

    expect(mockMarkRead).toHaveBeenCalledWith('scratch-x');
    expect(state.threadsById['scratch-x'].status).toBe('completed');
  });

  test('handleWSResult shows completion toast with truncated title for project threads', () => {
    const longTitle = 'This is a very long thread title that should truncate';
    const thread = buildThreadWithMessages({
      id: THREAD_ID,
      projectId: 'p1',
      title: longTitle,
      status: 'running',
    });
    const state = makeState({
      threadsById: { [THREAD_ID]: thread },
      threadDataById: { [THREAD_ID]: thread },
      activeThread: thread,
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0.02, duration: 5 });

    expect(mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining('completed'),
      expect.objectContaining({ id: `result-${THREAD_ID}` }),
    );
  });

  test('handleWSResult skips the completion toast of a factory thread while they are hidden', () => {
    const thread = buildThreadWithMessages({
      id: THREAD_ID,
      projectId: 'p1',
      title: '[Factory] #479 Clear',
      status: 'running',
      source: 'factory',
    });
    const state = makeState({
      threadsById: { [THREAD_ID]: thread },
      threadDataById: { [THREAD_ID]: thread },
      activeThread: thread,
    });
    const { get, set } = makeGetSet(state);
    useSidebarFilterStore.setState({ hideFactoryThreads: true });

    try {
      handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0, duration: 1 });
      expect(mocked(toast.success)).not.toHaveBeenCalled();

      useSidebarFilterStore.setState({ hideFactoryThreads: false });
      handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0, duration: 1 });
      expect(mocked(toast.success)).toHaveBeenCalledTimes(1);
    } finally {
      useSidebarFilterStore.setState({ hideFactoryThreads: true });
    }
  });

  test('handleWSResult shows failed toast with known error reason', () => {
    const thread = buildThreadWithMessages({
      id: THREAD_ID,
      projectId: 'p1',
      title: 'Budget run',
      status: 'running',
      cost: 0.5,
    });
    const state = makeState({
      threadsById: { [THREAD_ID]: thread },
      threadDataById: { [THREAD_ID]: thread },
      scratchThreadIds: [],
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, THREAD_ID, {
      status: 'failed',
      cost: 0.5,
      duration: 10,
      errorReason: 'error_max_budget_usd',
    });

    expect(mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining('Budget limit exceeded'),
      expect.objectContaining({ id: `result-${THREAD_ID}` }),
    );
  });

  describe('handleWSStageChanged', () => {
    test('applies a server-driven stage move to the board (in_progress → review)', () => {
      const thread = { ...makeState().activeThread, stage: 'in_progress' };
      const state = makeState({
        threadsById: { [THREAD_ID]: thread },
        threadDataById: { [THREAD_ID]: thread },
        activeThread: thread,
      });
      const { get, set } = makeGetSet(state);

      handleWSStageChanged(get, set, THREAD_ID, {
        fromStage: 'in_progress',
        toStage: 'review',
        projectId: 'p1',
      });

      expect(state.threadsById[THREAD_ID].stage).toBe('review');
      expect(state.threadDataById[THREAD_ID].stage).toBe('review');
    });

    test('toStage archived sets the archived flag without touching stage', () => {
      const thread = { ...makeState().activeThread, stage: 'review', archived: false };
      const state = makeState({
        threadsById: { [THREAD_ID]: thread },
        threadDataById: { [THREAD_ID]: thread },
        activeThread: thread,
      });
      const { get, set } = makeGetSet(state);

      handleWSStageChanged(get, set, THREAD_ID, {
        fromStage: 'review',
        toStage: 'archived',
        projectId: 'p1',
      });

      expect(state.threadsById[THREAD_ID].archived).toBe(true);
      expect(state.threadsById[THREAD_ID].stage).toBe('review');
    });

    test('a non-archived target on an archived thread un-archives and sets the stage', () => {
      const thread = { ...makeState().activeThread, stage: 'backlog', archived: true };
      const state = makeState({
        threadsById: { [THREAD_ID]: thread },
        threadDataById: { [THREAD_ID]: thread },
        activeThread: thread,
      });
      const { get, set } = makeGetSet(state);

      handleWSStageChanged(get, set, THREAD_ID, {
        fromStage: 'archived',
        toStage: 'planning',
        projectId: 'p1',
      });

      expect(state.threadsById[THREAD_ID].archived).toBe(false);
      expect(state.threadsById[THREAD_ID].stage).toBe('planning');
    });

    test('schedules a project refresh when the thread is not loaded', async () => {
      vi.useFakeTimers();
      const loadThreads = vi.fn();
      const state = makeState({
        threadsById: {},
        threadIdsByProject: { p9: ['other'] },
        threadDataById: {},
        selectedThreadId: null,
        activeThread: null,
        loadThreadsForProject: loadThreads,
      });
      const { get, set } = makeGetSet(state);

      handleWSStageChanged(get, set, 'unknown-1', {
        fromStage: 'backlog',
        toStage: 'in_progress',
        projectId: 'p9',
      });

      vi.advanceTimersByTime(2000);
      expect(loadThreads).toHaveBeenCalledWith('p9');
    });
  });
});
