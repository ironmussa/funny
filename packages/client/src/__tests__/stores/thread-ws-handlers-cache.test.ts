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
  transitionThreadStatus: vi.fn((_id: string, _evt: unknown, current: string) => current),
  wsEventToMachineEvent: vi.fn(() => ({ type: 'SET_STATUS', status: 'running' })),
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
  return {
    threadsByProject: {},
    threadTotalByProject: {},
    selectedThreadId: THREAD_ID,
    activeThread: {
      id: THREAD_ID,
      projectId: 'p1',
      title: 't',
      status: 'running',
      cost: 0,
      messages: [],
    },
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
});
