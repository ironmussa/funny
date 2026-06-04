import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockInvalidate, mockBuffer, mockEmitContextUsage, mockMarkRead, mockToastError } =
  vi.hoisted(() => ({
    mockInvalidate: vi.fn(),
    mockBuffer: vi.fn(),
    mockEmitContextUsage: vi.fn(),
    mockMarkRead: vi.fn(),
    mockToastError: vi.fn(),
  }));

const mockWsEventToMachine = vi.hoisted(() =>
  vi.fn((_kind: string, data: any) => ({
    type: 'SET_STATUS',
    status: data.status,
  })),
);

vi.mock('@/stores/thread-machine-bridge', () => ({
  invalidateThreadData: mockInvalidate,
  transitionThreadStatus: vi.fn(
    (_id: string, evt: { status?: string }, current: string) => evt.status ?? current,
  ),
  wsEventToMachineEvent: mockWsEventToMachine,
}));

vi.mock('@/stores/thread-read-store', () => ({
  useThreadReadStore: { getState: () => ({ markRead: mockMarkRead }) },
}));

vi.mock('@/stores/thread-store-internals', () => ({
  bufferWSEvent: mockBuffer,
  getNavigate: vi.fn(() => vi.fn()),
  getProjectIdForThread: vi.fn(() => null),
  // null → routing gates fall back to the passed state's selectedThreadId.
  getUrlThreadId: () => null,
  setUrlThreadId: vi.fn(),
}));

vi.mock('@/lib/context-usage-events', () => ({ emitContextUsage: mockEmitContextUsage }));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: mockToastError,
    dismiss: vi.fn(),
  },
}));

const { handleWSStatus, handleWSError, handleWSContextUsage, handleWSResult } =
  await import('@/stores/thread-ws-handlers');
import { toast } from 'sonner';

const THREAD_ID = 'thread-edge';

function makeState(overrides: Record<string, unknown> = {}) {
  const activeThread = {
    id: THREAD_ID,
    projectId: 'p1',
    title: 'Edge case',
    status: 'running',
    cost: 0,
    messages: [],
  };
  return {
    threadsById: { [THREAD_ID]: activeThread },
    threadIdsByProject: { p1: [THREAD_ID] },
    scratchThreadIds: [],
    threadTotalByProject: { p1: 1 },
    scratchThreadTotal: 0,
    selectedThreadId: THREAD_ID,
    threadDataById: { [THREAD_ID]: activeThread },
    activeThread,
    setupProgressByThread: {},
    contextUsageByThread: {},
    queuedCountByThread: {},
    loadThreadsForProject: vi.fn(),
    ...overrides,
  } as any;
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

  test('handleWSStatus no-ops when machine event is invalid', () => {
    mockWsEventToMachine.mockReturnValueOnce(null as any);
    const state = makeState();
    state.threadsById[THREAD_ID].status = 'idle';
    state.threadDataById[THREAD_ID].status = 'idle';
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'running' });

    expect(state.threadsById[THREAD_ID].status).toBe('idle');
    expect(state.threadDataById[THREAD_ID].status).toBe('idle');
  });

  test('handleWSContextUsage updates hydrated payload and emits event', () => {
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSContextUsage(get, set, THREAD_ID, {
      inputTokens: 100,
      outputTokens: 50,
      cumulativeInputTokens: 5000,
    });

    expect(mockEmitContextUsage).toHaveBeenCalledWith(THREAD_ID, {
      cumulativeInputTokens: 5000,
      lastInputTokens: 100,
      lastOutputTokens: 50,
    });
    expect(state.contextUsageByThread[THREAD_ID].cumulativeInputTokens).toBe(5000);
    expect(state.threadDataById[THREAD_ID].contextUsage.cumulativeInputTokens).toBe(5000);
  });

  test('handleWSContextUsage buffers when selected but not hydrated', () => {
    const state = makeState({
      selectedThreadId: THREAD_ID,
      threadDataById: {},
      activeThread: null,
    });
    const { get, set } = makeGetSet(state);

    handleWSContextUsage(get, set, THREAD_ID, {
      inputTokens: 10,
      outputTokens: 5,
      cumulativeInputTokens: 100,
    });

    expect(mockBuffer).toHaveBeenCalledWith(
      THREAD_ID,
      'context_usage',
      expect.objectContaining({ cumulativeInputTokens: 100 }),
    );
    expect(state.contextUsageByThread[THREAD_ID].cumulativeInputTokens).toBe(100);
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
    const scratchThread = {
      id: 'scratch-x',
      projectId: '',
      isScratch: true,
      title: 'Quick idea',
      status: 'running',
      cost: 0,
      messages: [],
    };
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
    const thread = {
      id: THREAD_ID,
      projectId: 'p1',
      title: longTitle,
      status: 'running',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      threadsById: { [THREAD_ID]: thread },
      threadDataById: { [THREAD_ID]: thread },
      activeThread: thread,
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0.02, duration: 5 });

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining('completed'),
      expect.objectContaining({ id: `result-${THREAD_ID}` }),
    );
  });

  test('handleWSResult shows failed toast with known error reason', () => {
    const thread = {
      id: THREAD_ID,
      projectId: 'p1',
      title: 'Budget run',
      status: 'running',
      cost: 0.5,
      messages: [],
    };
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

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining('Budget limit exceeded'),
      expect.objectContaining({ id: `result-${THREAD_ID}` }),
    );
  });
});
