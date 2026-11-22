import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

/**
 * `selectThread` runs on every route sync. Its caller trace captures a stack
 * (`new Error().stack`), which costs far more than the call itself, so it must
 * only be built when the `thread-select` namespace logs at `debug`.
 */
import { okAsync } from 'neverthrow';

const mocks = (() => ({
  debugEnabled: false,
  selectDebug: vi.fn(),
  getThread: vi.fn(),
  listThreads: vi.fn(),
}))();

const noopLogger = () => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

mock.module('@/lib/client-logger', () => ({
  createClientLogger: (namespace: string) =>
    namespace === 'thread-select' ? { ...noopLogger(), debug: mocks.selectDebug } : noopLogger(),
  isClientLogLevelEnabled: (namespace: string, level: string) =>
    namespace === 'thread-select' && level === 'debug' && mocks.debugEnabled,
}));

mock.module('@/lib/api/threads', () => ({
  threadsApi: {
    sendMessage: vi.fn(),
    stopThread: vi.fn(),
    approveTool: vi.fn(),
    searchThreadContent: vi.fn(),
    getThread: mocks.getThread,
    getThreadEvents: vi.fn(() => okAsync({ events: [] })),
    listThreads: mocks.listThreads,
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    archiveThread: vi.fn(),
    getThreadMessages: vi.fn(),
    renameThread: vi.fn(),
    pinThread: vi.fn(),
    updateThreadStage: vi.fn(),
  },
}));

mock.module('@/stores/store-bridge', () => ({
  expandProject: vi.fn(),
  selectProject: vi.fn(),
  getProjectPath: vi.fn(),
  registerThreadStore: vi.fn(),
}));

mock.module('@/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ selectProject: vi.fn() }), subscribe: vi.fn() },
}));

mock.module('@/lib/telemetry', () => ({
  startSpan: () => ({
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-00`,
    end: () => {},
  }),
  metric: vi.fn(),
}));

// Imported after the mocks (bun's mock.module is not hoisted).
const { buildThreadWithMessages, withThreadIndex } = await import('@/data/threads/testing');
const { useThreadStore } = await import('@/stores/thread-store');
const { setSelectingThreadId } = await import('@/stores/thread-store-internals');

const target = {
  ...buildThreadWithMessages({ id: 'thread-B', projectId: 'proj-1', title: 'B' }),
  threadEvents: [],
};

function selectCalls() {
  return mocks.selectDebug.mock.calls.filter(([msg]) => msg === 'selectThread called');
}

describe('selectThread caller trace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThread.mockReturnValue(okAsync(target));
    mocks.listThreads.mockReturnValue(okAsync({ threads: [], total: 0 }));
    useThreadStore.setState(
      withThreadIndex({ selectedThreadId: null, activeThread: null, threadDataById: {} }),
    );
    setSelectingThreadId(null);
  });

  test('builds no stack and logs nothing when debug is off', async () => {
    mocks.debugEnabled = false;
    await useThreadStore.getState().selectThread(target.id);
    expect(selectCalls()).toHaveLength(0);
  });

  test('logs the caller chain when debug is on', async () => {
    mocks.debugEnabled = true;
    await useThreadStore.getState().selectThread(target.id);
    const calls = selectCalls();
    expect(calls).toHaveLength(1);
    expect(typeof (calls[0][1] as { caller?: unknown }).caller).toBe('string');
  });
});
