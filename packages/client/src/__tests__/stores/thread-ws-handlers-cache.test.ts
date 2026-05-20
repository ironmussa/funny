/**
 * Regression: WS handlers must invalidate the data-actor cache for the
 * affected thread **even when it is the currently active thread**.
 *
 * Bug: when an event arrived for the active thread, the cache snapshot held
 * by the data actor was left intact. Switching away and back resolved from
 * that stale snapshot, so a completed thread looked unfinished until refresh.
 *
 * Each handler is exercised with `activeThread.id === threadId` and the spy
 * on `invalidateThreadData` must fire.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockInvalidate } = vi.hoisted(() => ({
  mockInvalidate: vi.fn(),
}));

vi.mock('@/stores/thread-machine-bridge', () => ({
  invalidateThreadData: mockInvalidate,
  // Echo back the data status so tests can drive transitions directly.
  transitionThreadStatus: vi.fn(
    (_id: string, evt: { status?: string }, current: string) => evt.status ?? current,
  ),
  wsEventToMachineEvent: vi.fn((_kind: string, data: any) => ({
    type: 'SET_STATUS',
    status: data.status,
  })),
}));

vi.mock('@/stores/thread-read-store', () => ({
  useThreadReadStore: { getState: () => ({ markRead: vi.fn() }) },
}));

vi.mock('@/stores/thread-store-internals', () => ({
  bufferWSEvent: vi.fn(),
  getNavigate: vi.fn(),
  getProjectIdForThread: vi.fn(() => null),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { handleWSMessage, handleWSToolCall, handleWSToolOutput, handleWSStatus, handleWSResult } =
  await import('@/stores/thread-ws-handlers');

const THREAD_ID = 'thread-active';

function makeState(overrides: Record<string, unknown> = {}) {
  const activeThread = {
    id: THREAD_ID,
    projectId: 'p1',
    title: 't',
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
    activeThread,
    setupProgressByThread: {},
    contextUsageByThread: {},
    queuedCountByThread: {},
    liveThreads: {},
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

describe('thread-ws-handlers — cache invalidation for the active thread', () => {
  beforeEach(() => {
    mockInvalidate.mockClear();
  });

  test('handleWSMessage invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSMessage(get, set, THREAD_ID, { role: 'assistant', content: 'hi' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSToolCall invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSToolCall(get, set, THREAD_ID, { name: 'Bash', input: {} });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSToolOutput invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSToolOutput(get, set, THREAD_ID, { toolCallId: 'tc1', output: 'ok' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSStatus invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSStatus(get, set, THREAD_ID, { status: 'running' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSResult invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0, duration: 1 });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSStatus updates a scratch thread via threadsById', () => {
    const scratchThread = {
      id: 'scratch-1',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'idle',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-1': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-1'],
    });
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, 'scratch-1', { status: 'running' });

    expect(state.threadsById['scratch-1'].status).toBe('running');
  });

  test('handleWSMessage updates lastAssistantMessage on a scratch thread', () => {
    const scratchThread = {
      id: 'scratch-3',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'running',
      cost: 0,
      messages: [],
      lastAssistantMessage: '¡Hola que te puedo ayudar...',
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-3': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-3'],
    });
    const { get, set } = makeGetSet(state);

    handleWSMessage(get, set, 'scratch-3', {
      role: 'assistant',
      content: 'La capital de Francia es París.',
    });

    expect(state.threadsById['scratch-3'].lastAssistantMessage).toBe(
      'La capital de Francia es París.',
    );
  });

  test('handleWSResult updates a scratch thread via threadsById', () => {
    const scratchThread = {
      id: 'scratch-2',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'running',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-2': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-2'],
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, 'scratch-2', { status: 'completed', cost: 0.5, duration: 1 });

    expect(state.threadsById['scratch-2'].status).toBe('completed');
    expect(state.threadsById['scratch-2'].cost).toBe(0.5);
  });
});
