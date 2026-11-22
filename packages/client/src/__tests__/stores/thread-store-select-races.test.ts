import { describe, test, expect, beforeEach, vi, mock } from 'bun:test';

/**
 * Races in `selectThread` (#234): overlapping selections, a deselect while a
 * load is in flight, and WS events that land before the payload does.
 *
 * The real select internals (generation counter, in-flight id, WS buffer) and
 * the real WS handlers run here; only the thread data load is replaced with
 * promises each test settles in the order it wants.
 *
 * Already covered elsewhere, not repeated: a stuck in-flight id and throws
 * before the fetch (thread-store-select-stuck), A → B → A keeping the WS buffer
 * for the newer A load (thread-store-actions, #225), back-fill realignment
 * while a select is in flight (thread-store-backfill).
 */
import { okAsync } from 'neverthrow';

import { deferred } from '../helpers/data-layer-harness';
import { seedThreads } from '../helpers/seed-thread-state';

const { mockLoadThreadData, mockSelectProject } = (() => ({
  mockLoadThreadData: vi.fn(),
  mockSelectProject: vi.fn(),
}))();

mock.module('@/lib/api/threads', () => ({
  threadsApi: {
    listThreads: vi.fn(() => okAsync({ threads: [], total: 0 })),
    getThread: vi.fn(),
    getThreadEvents: vi.fn(),
  },
}));

mock.module('@/stores/thread-machine-bridge', () => ({
  transitionThreadStatus: vi.fn().mockReturnValue('running'),
  wsEventToMachineEvent: vi.fn(),
  cleanupThreadActor: vi.fn(),
  loadThreadData: mockLoadThreadData,
  isThreadDataLoaded: vi.fn().mockReturnValue(false),
  isThreadDataPrefetched: vi.fn().mockReturnValue(false),
  prefetchThreadData: vi.fn(),
  invalidateThreadData: vi.fn(),
}));

mock.module('@/stores/store-bridge', () => ({
  expandProject: vi.fn(),
  selectProject: mockSelectProject,
  getProjectPath: vi.fn(),
  registerThreadStore: vi.fn(),
}));

mock.module('@/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ selectProject: vi.fn() }), subscribe: vi.fn() },
}));

// Imported after the mocks (bun's mock.module is not hoisted).
const { buildThread, buildThreadWithMessages, withThreadIndex } =
  await import('@/data/threads/testing');
const { useThreadStore } = await import('@/stores/thread-store');
const { getSelectingThreadId, setSelectingThreadId, clearWSBuffer } =
  await import('@/stores/thread-store-internals');

const rowA = buildThread({ id: 'thread-A', projectId: 'proj-A', title: 'A' });
const rowB = buildThread({ id: 'thread-B', projectId: 'proj-B', title: 'B' });

function snapshotOf(row: typeof rowA, title = row.title) {
  return { thread: buildThreadWithMessages({ ...row, title, messages: [] }), events: [] };
}

type Snapshot = ReturnType<typeof snapshotOf>;

describe('selectThread races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {},
        threadIdsByProject: {},
        scratchThreadIds: [],
        selectedThreadId: null,
        activeThread: null,
        threadDataById: {},
        threadLoadFailedId: null,
      }),
    );
    useThreadStore.setState({ ...seedThreads({ 'proj-A': [rowA], 'proj-B': [rowB] }) });
    setSelectingThreadId(null);
    clearWSBuffer(rowA.id);
    clearWSBuffer(rowB.id);
  });

  test('A then B: a late load of A does not replace B or select A’s project', async () => {
    const loadA = deferred<Snapshot>();
    const loadB = deferred<Snapshot>();
    mockLoadThreadData.mockReturnValueOnce(loadA.promise).mockReturnValueOnce(loadB.promise);

    const store = useThreadStore.getState();
    const pA = store.selectThread(rowA.id);
    const pB = store.selectThread(rowB.id);

    loadB.resolve(snapshotOf(rowB));
    await pB;
    loadA.resolve(snapshotOf(rowA));
    await pA;

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(rowB.id);
    expect(state.activeThread?.id).toBe(rowB.id);
    // The stale payload never lands: nothing anchors it, so it would only leak.
    expect(state.threadDataById[rowA.id]).toBeUndefined();
    expect(mockSelectProject).toHaveBeenCalledTimes(1);
    expect(mockSelectProject).toHaveBeenLastCalledWith('proj-B');
    expect(getSelectingThreadId()).toBeNull();
  });

  test('A then B: a late failure of A does not clear B or mark a failed load', async () => {
    const loadA = deferred<Snapshot>();
    const loadB = deferred<Snapshot>();
    mockLoadThreadData.mockReturnValueOnce(loadA.promise).mockReturnValueOnce(loadB.promise);

    const store = useThreadStore.getState();
    const pA = store.selectThread(rowA.id);
    const pB = store.selectThread(rowB.id);

    loadB.resolve(snapshotOf(rowB));
    await pB;
    loadA.reject(new Error('network'));
    await pA;

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(rowB.id);
    expect(state.activeThread?.id).toBe(rowB.id);
    expect(state.threadLoadFailedId).toBeNull();
  });

  test('selecting the same thread twice while it loads fetches it once', async () => {
    const loadA = deferred<Snapshot>();
    mockLoadThreadData.mockReturnValue(loadA.promise);

    const store = useThreadStore.getState();
    const first = store.selectThread(rowA.id);
    const second = store.selectThread(rowA.id);

    loadA.resolve(snapshotOf(rowA));
    await Promise.all([first, second]);

    expect(mockLoadThreadData).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().activeThread?.id).toBe(rowA.id);
    expect(getSelectingThreadId()).toBeNull();
  });

  test('A → B → A: the first A settling does not release the newer A load', async () => {
    const firstA = deferred<Snapshot>();
    const loadB = deferred<Snapshot>();
    const secondA = deferred<Snapshot>();
    mockLoadThreadData
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(loadB.promise)
      .mockReturnValueOnce(secondA.promise);

    const store = useThreadStore.getState();
    const p1 = store.selectThread(rowA.id);
    const p2 = store.selectThread(rowB.id);
    const p3 = store.selectThread(rowA.id);

    firstA.resolve(snapshotOf(rowA, 'stale A'));
    await p1;
    // The newer A load still owns the in-flight slot, so a repeat select
    // (StrictMode double-fire, route sync) is still deduplicated.
    expect(getSelectingThreadId()).toBe(rowA.id);
    await store.selectThread(rowA.id);
    expect(mockLoadThreadData).toHaveBeenCalledTimes(3);

    loadB.resolve(snapshotOf(rowB));
    await p2;
    secondA.resolve(snapshotOf(rowA, 'fresh A'));
    await p3;

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBe(rowA.id);
    expect(state.activeThread?.title).toBe('fresh A');
    expect(state.threadDataById[rowB.id]).toBeUndefined();
    expect(getSelectingThreadId()).toBeNull();
  });

  test('deselecting while A loads keeps the selection empty when A arrives', async () => {
    const loadA = deferred<Snapshot>();
    mockLoadThreadData.mockReturnValueOnce(loadA.promise);

    const store = useThreadStore.getState();
    const pA = store.selectThread(rowA.id);
    await store.selectThread(null);

    loadA.resolve(snapshotOf(rowA));
    await pA;

    const state = useThreadStore.getState();
    expect(state.selectedThreadId).toBeNull();
    expect(state.activeThread).toBeNull();
    expect(state.threadDataById[rowA.id]).toBeUndefined();
    expect(mockSelectProject).not.toHaveBeenCalled();
    expect(getSelectingThreadId()).toBeNull();
  });

  test('a WS message that arrives during the load is replayed onto the payload', async () => {
    const loadA = deferred<Snapshot>();
    mockLoadThreadData.mockReturnValueOnce(loadA.promise);

    const store = useThreadStore.getState();
    const pA = store.selectThread(rowA.id);

    useThreadStore.getState().handleWSMessage(rowA.id, {
      messageId: 'msg-live',
      role: 'assistant',
      content: 'arrived mid-load',
    } as any);
    // Not applied yet: there is no payload to apply it to.
    expect(useThreadStore.getState().threadDataById[rowA.id]).toBeUndefined();

    loadA.resolve(snapshotOf(rowA));
    await pA;

    const messages = useThreadStore.getState().activeThread?.messages ?? [];
    expect(messages.map((m) => m.id)).toContain('msg-live');
    expect(messages.find((m) => m.id === 'msg-live')?.content).toBe('arrived mid-load');
  });
});
