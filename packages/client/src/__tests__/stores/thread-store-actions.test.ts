import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockSendMessage,
  mockStopThread,
  mockApproveTool,
  mockSearchThreadContent,
  mockGetThread,
  mockGetThreadEvents,
  mockDeleteThread,
  mockListThreads,
  mockListScratchThreads,
  mockLoadThreadData,
  mockIsThreadDataLoaded,
  mockArchiveThread,
  mockRenameThread,
  mockPinThread,
  mockUpdateThreadStage,
  mockGetThreadMessages,
  mockCleanupThreadActor,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockStopThread: vi.fn(),
  mockApproveTool: vi.fn(),
  mockSearchThreadContent: vi.fn(),
  mockGetThread: vi.fn(),
  mockGetThreadEvents: vi.fn(),
  mockDeleteThread: vi.fn(),
  mockListThreads: vi.fn(),
  mockListScratchThreads: vi.fn(),
  mockLoadThreadData: vi.fn(),
  mockIsThreadDataLoaded: vi.fn(),
  mockArchiveThread: vi.fn(),
  mockRenameThread: vi.fn(),
  mockPinThread: vi.fn(),
  mockUpdateThreadStage: vi.fn(),
  mockGetThreadMessages: vi.fn(),
  mockCleanupThreadActor: vi.fn(),
}));

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    sendMessage: mockSendMessage,
    stopThread: mockStopThread,
    approveTool: mockApproveTool,
    searchThreadContent: mockSearchThreadContent,
    getThread: mockGetThread,
    getThreadEvents: mockGetThreadEvents,
    listThreads: mockListThreads,
    listScratchThreads: mockListScratchThreads,
    updateThread: vi.fn(),
    deleteThread: mockDeleteThread,
    archiveThread: mockArchiveThread,
    getThreadMessages: mockGetThreadMessages,
    renameThread: mockRenameThread,
    pinThread: mockPinThread,
    updateThreadStage: mockUpdateThreadStage,
  },
}));

vi.mock('@/stores/store-bridge', () => ({
  expandProject: vi.fn(),
  selectProject: vi.fn(),
  getProjectPath: vi.fn(),
  registerThreadStore: vi.fn(),
}));

vi.mock('@/stores/thread-machine-bridge', () => ({
  transitionThreadStatus: vi.fn().mockReturnValue('running'),
  cleanupThreadActor: mockCleanupThreadActor,
  loadThreadData: mockLoadThreadData,
  isThreadDataLoaded: mockIsThreadDataLoaded,
  isThreadDataPrefetched: vi.fn().mockReturnValue(false),
  prefetchThreadData: vi.fn(),
  invalidateThreadData: vi.fn(),
}));

vi.mock('@/stores/thread-read-store', () => ({
  useThreadReadStore: { getState: () => ({ markRead: vi.fn() }) },
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ selectProject: vi.fn() }), subscribe: vi.fn() },
}));

vi.mock('@/stores/thread-ws-handlers', () => ({
  handleWSInit: vi.fn(),
  handleWSMessage: vi.fn(),
  handleWSToolCall: vi.fn(),
  handleWSToolOutput: vi.fn(),
  handleWSStatus: vi.fn(),
  handleWSError: vi.fn(),
  handleWSResult: vi.fn(),
  handleWSQueueUpdate: vi.fn(),
  handleWSCompactBoundary: vi.fn(),
  handleWSContextUsage: vi.fn(),
}));

vi.mock('@/stores/thread-store-internals', () => ({
  nextSelectGeneration: vi.fn().mockReturnValue(1),
  getSelectGeneration: vi.fn().mockReturnValue(1),
  getBufferedInitInfo: vi.fn(),
  setBufferedInitInfo: vi.fn(),
  getAndClearWSBuffer: vi.fn().mockReturnValue([]),
  clearWSBuffer: vi.fn(),
  getSelectingThreadId: vi.fn(),
  setSelectingThreadId: vi.fn(),
  rebuildThreadProjectIndex: vi.fn(),
  invalidateSelectThread: vi.fn(),
  setAppNavigate: vi.fn(),
  notifyThreadSelected: vi.fn(),
  setClearThreadSelection: vi.fn(),
}));

import { useThreadStore } from '@/stores/thread-store';

import { seedThreads } from '../helpers/seed-thread-state';

const baseThread = {
  id: 't1',
  projectId: 'p1',
  title: 'thread',
  mode: 'local',
  status: 'completed',
  cost: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  hasMore: false,
  messages: [],
};

describe('thread store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState({
      threadsById: {},
      threadIdsByProject: {},
      scratchThreadIds: [],
      threadTotalByProject: {},
      scratchThreadTotal: 0,
      selectedThreadId: null,
      threadDataById: {},
      activeThread: null,
      setupProgressByThread: {},
      contextUsageByThread: {},
      queuedCountByThread: {},
    });
  });

  describe('sendMessage', () => {
    test('returns true on success', async () => {
      mockSendMessage.mockReturnValue(okAsync({ ok: true }));

      const result = await useThreadStore.getState().sendMessage('thread-1', 'hello');

      expect(result).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith('thread-1', 'hello', undefined, undefined);
    });

    test('returns false on failure', async () => {
      mockSendMessage.mockReturnValue(errAsync(new Error('network error')));

      const result = await useThreadStore.getState().sendMessage('thread-1', 'hello');

      expect(result).toBe(false);
      expect(mockSendMessage).toHaveBeenCalledWith('thread-1', 'hello', undefined, undefined);
    });

    test('passes options to api.sendMessage', async () => {
      mockSendMessage.mockReturnValue(okAsync({ ok: true }));

      const options = { model: 'sonnet' as any, permissionMode: 'auto' as any };
      const result = await useThreadStore.getState().sendMessage('thread-2', 'build it', options);

      expect(result).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        'thread-2',
        'build it',
        { model: 'sonnet', permissionMode: 'auto' },
        undefined,
      );
    });
  });

  describe('stopThread', () => {
    test('calls api.stopThread with correct threadId', async () => {
      mockStopThread.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().stopThread('thread-42');

      expect(mockStopThread).toHaveBeenCalledWith('thread-42');
    });
  });

  describe('approveTool', () => {
    test('calls api.approveTool with all params and returns true on success', async () => {
      mockApproveTool.mockReturnValue(okAsync({ ok: true }));

      const result = await useThreadStore
        .getState()
        .approveTool('thread-5', 'Write', true, ['Write', 'Edit'], ['Bash']);

      expect(result).toBe(true);
      expect(mockApproveTool).toHaveBeenCalledWith(
        'thread-5',
        'Write',
        true,
        ['Write', 'Edit'],
        ['Bash'],
        undefined,
      );
    });

    test('returns false on failure', async () => {
      mockApproveTool.mockReturnValue(errAsync(new Error('approval failed')));

      const result = await useThreadStore.getState().approveTool('thread-5', 'Write', false);

      expect(result).toBe(false);
    });
  });

  describe('searchThreadContent', () => {
    test('returns results on success', async () => {
      const searchResults = {
        threadIds: ['t1', 't2'],
        snippets: { t1: 'match in thread 1', t2: 'match in thread 2' },
      };
      mockSearchThreadContent.mockReturnValue(okAsync(searchResults));

      const result = await useThreadStore.getState().searchThreadContent('search query', 'proj-1');

      expect(result).toEqual(searchResults);
      expect(mockSearchThreadContent).toHaveBeenCalledWith('search query', 'proj-1');
    });

    test('returns null on failure', async () => {
      mockSearchThreadContent.mockReturnValue(errAsync(new Error('search failed')));

      const result = await useThreadStore.getState().searchThreadContent('bad query');

      expect(result).toBeNull();
      expect(mockSearchThreadContent).toHaveBeenCalledWith('bad query', undefined);
    });
  });

  describe('refreshActiveThread (WS-disconnect resync)', () => {
    const baseThread = {
      id: 't1',
      projectId: 'p1',
      title: 'thread',
      mode: 'local',
      status: 'running',
      cost: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      hasMore: false,
    };

    const setActiveThread = (messages: any[]) => {
      const thread = { ...(baseThread as any), messages };
      useThreadStore.setState({
        selectedThreadId: thread.id,
        threadDataById: { [thread.id]: thread },
        activeThread: thread,
      } as any);
    };

    beforeEach(() => {
      mockGetThreadEvents.mockReturnValue(okAsync({ events: [] }));
    });

    test('recovers messages emitted while WS was disconnected', async () => {
      const localMessages = [
        {
          id: 'm1',
          threadId: 't1',
          role: 'user',
          content: 'hi',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'm2',
          threadId: 't1',
          role: 'assistant',
          content: 'hello',
          timestamp: '2026-01-01T00:00:01.000Z',
        },
      ];
      setActiveThread(localMessages);

      // Server returns the local two PLUS three messages the client missed
      // while disconnected.
      mockGetThread.mockReturnValue(
        okAsync({
          ...baseThread,
          messages: [
            ...localMessages,
            {
              id: 'm3',
              threadId: 't1',
              role: 'assistant',
              content: 'working',
              timestamp: '2026-01-01T00:00:05.000Z',
            },
            {
              id: 'm4',
              threadId: 't1',
              role: 'assistant',
              content: 'done',
              timestamp: '2026-01-01T00:00:10.000Z',
            },
            {
              id: 'm5',
              threadId: 't1',
              role: 'user',
              content: 'thx',
              timestamp: '2026-01-01T00:00:11.000Z',
            },
          ],
        }),
      );

      await useThreadStore.getState().refreshActiveThread();

      const merged = useThreadStore.getState().activeThread!.messages;
      expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    });

    test('preserves older paginated messages not in fresh window', async () => {
      const olderPaginated = {
        id: 'm0',
        threadId: 't1',
        role: 'user',
        content: 'older',
        timestamp: '2025-12-31T00:00:00.000Z',
      };
      const recent = {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'recent',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      setActiveThread([olderPaginated, recent]);

      mockGetThread.mockReturnValue(
        okAsync({
          ...baseThread,
          messages: [
            recent,
            {
              id: 'm2',
              threadId: 't1',
              role: 'assistant',
              content: 'new',
              timestamp: '2026-01-01T00:00:05.000Z',
            },
          ],
        }),
      );

      await useThreadStore.getState().refreshActiveThread();

      const merged = useThreadStore.getState().activeThread!.messages;
      expect(merged.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    });

    test('drops optimistic duplicates inside the fresh window', async () => {
      // Local has an optimistic user message with a random UUID; the server
      // persisted the same content under a different real ID.
      const optimistic = {
        id: 'optimistic-uuid',
        threadId: 't1',
        role: 'user',
        content: 'sent',
        timestamp: '2026-01-01T00:00:02.000Z',
      };
      setActiveThread([optimistic]);

      mockGetThread.mockReturnValue(
        okAsync({
          ...baseThread,
          messages: [
            {
              id: 'real-id',
              threadId: 't1',
              role: 'user',
              content: 'sent',
              timestamp: '2026-01-01T00:00:02.000Z',
            },
            {
              id: 'reply',
              threadId: 't1',
              role: 'assistant',
              content: 'ack',
              timestamp: '2026-01-01T00:00:03.000Z',
            },
          ],
        }),
      );

      await useThreadStore.getState().refreshActiveThread();

      const merged = useThreadStore.getState().activeThread!.messages;
      expect(merged.map((m) => m.id)).toEqual(['real-id', 'reply']);
    });

    test('preserves WS message that lands between fetch and set', async () => {
      // Regression: refreshActiveThread used to capture activeThread before
      // its `await api.getThread()`, so a WS agent:message that mutated
      // activeThread during the in-flight fetch got clobbered when the
      // post-await `set()` spread the stale capture. The fix reads
      // activeThread inside `set((state) => …)`.
      const existing = {
        id: 'm1',
        threadId: 't1',
        role: 'user' as const,
        content: 'q',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const wsMessage = {
        id: 'm2',
        threadId: 't1',
        role: 'assistant' as const,
        content: 'a',
        timestamp: '2026-01-01T00:00:01.000Z',
      };
      setActiveThread([existing]);

      // Server response races with the WS event: fetch resolves AFTER we
      // simulate the WS message landing in the payload map, but returns only
      // the pre-WS state.
      mockGetThread.mockImplementation(() => {
        useThreadStore.setState((s) => {
          const tid = s.selectedThreadId!;
          const next = { ...s.threadDataById[tid]!, messages: [existing, wsMessage] };
          return {
            threadDataById: { ...s.threadDataById, [tid]: next },
            activeThread: next,
          };
        });
        return okAsync({ ...baseThread, messages: [existing] });
      });

      await useThreadStore.getState().refreshActiveThread();

      const merged = useThreadStore.getState().activeThread!.messages;
      expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    test('keeps locally-newer messages added after the fresh window', async () => {
      const fresh = {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'old',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const localNewer = {
        id: 'optimistic-new',
        threadId: 't1',
        role: 'user',
        content: 'just sent',
        timestamp: '2026-01-01T00:01:00.000Z',
      };
      setActiveThread([fresh, localNewer]);

      mockGetThread.mockReturnValue(okAsync({ ...baseThread, messages: [fresh] }));

      await useThreadStore.getState().refreshActiveThread();

      const merged = useThreadStore.getState().activeThread!.messages;
      expect(merged.map((m) => m.id)).toEqual(['m1', 'optimistic-new']);
    });
  });

  describe('loadThreadsForProject', () => {
    test('bails on empty projectId so scratch threads do not leak into threadsByProject[""]', async () => {
      mockListThreads.mockClear();

      await useThreadStore.getState().loadThreadsForProject('');

      expect(mockListThreads).not.toHaveBeenCalled();
      expect(useThreadStore.getState().threadIdsByProject['']).toBeUndefined();
    });

    test('replaces project bucket on successful fetch', async () => {
      const threads = [{ ...baseThread, id: 't-new', title: 'New' }];
      mockListThreads.mockReturnValue(okAsync({ threads, total: 1 }));

      await useThreadStore.getState().loadThreadsForProject('p1');

      expect(useThreadStore.getState().threadIdsByProject.p1).toEqual(['t-new']);
      expect(useThreadStore.getState().threadsById['t-new'].title).toBe('New');
    });
  });

  describe('loadMoreThreads', () => {
    test('appends paginated threads without duplicating ids', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, id: 't1' } as any] }),
        threadTotalByProject: { p1: 2 },
      } as any);
      mockListThreads.mockReturnValue(
        okAsync({ threads: [{ ...baseThread, id: 't2', title: 'Page 2' }], total: 2 }),
      );

      await useThreadStore.getState().loadMoreThreads('p1');

      expect(useThreadStore.getState().threadIdsByProject.p1).toEqual(['t1', 't2']);
    });
  });

  describe('deleteThread', () => {
    beforeEach(() => {
      mockDeleteThread.mockReturnValue(okAsync({ ok: true }));
      mockStopThread.mockReturnValue(okAsync({ ok: true }));
    });

    test('removes thread from store and clears selection', async () => {
      const payload = { ...baseThread, messages: [] };
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
        threadTotalByProject: { p1: 1 },
        selectedThreadId: 't1',
        activeThread: payload as any,
        threadDataById: { t1: payload as any },
      } as any);

      await useThreadStore.getState().deleteThread('t1', 'p1');

      expect(useThreadStore.getState().threadsById.t1).toBeUndefined();
      expect(useThreadStore.getState().selectedThreadId).toBeNull();
      expect(useThreadStore.getState().activeThread).toBeNull();
      expect(useThreadStore.getState().threadDataById.t1).toBeUndefined();
      expect(mockDeleteThread).toHaveBeenCalledWith('t1');
    });

    test('stops running threads before delete', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, status: 'running' } as any] }),
        threadTotalByProject: { p1: 1 },
      } as any);

      await useThreadStore.getState().deleteThread('t1', 'p1');

      expect(mockStopThread).toHaveBeenCalledWith('t1');
      expect(mockDeleteThread).toHaveBeenCalledWith('t1');
    });
  });

  describe('deleteScratchThread', () => {
    beforeEach(() => {
      mockDeleteThread.mockReturnValue(okAsync({ ok: true }));
      mockStopThread.mockReturnValue(okAsync({ ok: true }));
    });

    test('removes scratch thread from scratch bucket', async () => {
      const scratch = {
        ...baseThread,
        id: 's1',
        projectId: '',
        isScratch: true,
      };
      useThreadStore.setState({
        threadsById: { s1: scratch as any },
        scratchThreadIds: ['s1'],
        scratchThreadTotal: 1,
        threadIdsByProject: {},
        threadTotalByProject: {},
      } as any);

      await useThreadStore.getState().deleteScratchThread('s1');

      expect(useThreadStore.getState().threadsById.s1).toBeUndefined();
      expect(useThreadStore.getState().scratchThreadIds).toEqual([]);
      expect(useThreadStore.getState().scratchThreadTotal).toBe(0);
      expect(mockDeleteThread).toHaveBeenCalledWith('s1');
    });
  });

  describe('selectThread', () => {
    beforeEach(() => {
      mockIsThreadDataLoaded.mockReturnValue(false);
      mockLoadThreadData.mockResolvedValue({
        thread: { ...baseThread, messages: [] },
        events: [],
      });
    });

    test('clears selection when passed null', async () => {
      useThreadStore.setState({
        selectedThreadId: 't1',
        activeThread: { ...baseThread, messages: [] } as any,
        threadDataById: { t1: { ...baseThread, messages: [] } as any },
      } as any);

      await useThreadStore.getState().selectThread(null);

      expect(useThreadStore.getState().selectedThreadId).toBeNull();
      expect(useThreadStore.getState().activeThread).toBeNull();
      expect(mockLoadThreadData).not.toHaveBeenCalled();
    });

    test('hydrates thread payload on successful select', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
        threadTotalByProject: { p1: 1 },
      } as any);

      await useThreadStore.getState().selectThread('t1');

      expect(mockLoadThreadData).toHaveBeenCalledWith('t1');
      expect(useThreadStore.getState().selectedThreadId).toBe('t1');
      expect(useThreadStore.getState().threadDataById.t1).toBeDefined();
      expect(useThreadStore.getState().activeThread?.id).toBe('t1');
    });

    test('clears selection when hydration fails', async () => {
      mockLoadThreadData.mockRejectedValueOnce(new Error('network'));
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);

      await useThreadStore.getState().selectThread('t1');

      expect(useThreadStore.getState().selectedThreadId).toBeNull();
      expect(useThreadStore.getState().activeThread).toBeNull();
    });
  });

  describe('loadScratchThreads', () => {
    test('replaces scratch bucket on successful fetch', async () => {
      const scratch = {
        ...baseThread,
        id: 's1',
        projectId: '',
        isScratch: true,
        title: 'Scratch idea',
      };
      mockListScratchThreads.mockReturnValue(okAsync({ threads: [scratch], total: 1 }));

      await useThreadStore.getState().loadScratchThreads();

      expect(useThreadStore.getState().scratchThreadIds).toEqual(['s1']);
      expect(useThreadStore.getState().threadsById.s1.title).toBe('Scratch idea');
    });
  });

  describe('addScratchThread', () => {
    test('prepends scratch thread to scratch bucket', () => {
      const existing = {
        ...baseThread,
        id: 's0',
        projectId: '',
        isScratch: true,
      };
      const incoming = {
        ...baseThread,
        id: 's1',
        projectId: '',
        isScratch: true,
        title: 'New scratch',
      };
      useThreadStore.setState({
        threadsById: { s0: existing as any },
        scratchThreadIds: ['s0'],
        scratchThreadTotal: 1,
        threadIdsByProject: {},
        threadTotalByProject: {},
      } as any);

      useThreadStore.getState().addScratchThread(incoming as any);

      expect(useThreadStore.getState().scratchThreadIds).toEqual(['s1', 's0']);
      expect(useThreadStore.getState().threadsById.s1.title).toBe('New scratch');
    });
  });

  describe('archiveThread', () => {
    test('optimistically archives and keeps archived on success', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockArchiveThread.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().archiveThread('t1');

      expect(useThreadStore.getState().threadsById.t1.archived).toBe(true);
      expect(mockArchiveThread).toHaveBeenCalledWith('t1', true);
    });

    test('rolls back archived flag when api fails', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockArchiveThread.mockReturnValue(errAsync(new Error('nope')));

      await useThreadStore.getState().archiveThread('t1');

      expect(useThreadStore.getState().threadsById.t1.archived).not.toBe(true);
    });
  });

  describe('renameThread', () => {
    test('updates title optimistically and keeps it on success', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockRenameThread.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().renameThread('t1', 'p1', 'Renamed');

      expect(useThreadStore.getState().threadsById.t1.title).toBe('Renamed');
    });

    test('rolls back title when api fails', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockRenameThread.mockReturnValue(errAsync(new Error('nope')));

      await useThreadStore.getState().renameThread('t1', 'p1', 'Renamed');

      expect(useThreadStore.getState().threadsById.t1.title).toBe('thread');
    });
  });

  describe('pinThread', () => {
    test('pins thread optimistically', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockPinThread.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().pinThread('t1', 'p1', true);

      expect(useThreadStore.getState().threadsById.t1.pinned).toBe(true);
    });

    test('rolls back pin when api fails', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, pinned: false } as any] }),
      } as any);
      mockPinThread.mockReturnValue(errAsync(new Error('nope')));

      await useThreadStore.getState().pinThread('t1', 'p1', true);

      expect(useThreadStore.getState().threadsById.t1.pinned).toBe(false);
    });
  });

  describe('unarchiveThread', () => {
    test('unarchives and updates stage on success', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, archived: true, stage: 'backlog' } as any] }),
      } as any);
      mockArchiveThread.mockReturnValue(okAsync({ ok: true }));
      mockUpdateThreadStage.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().unarchiveThread('t1', 'p1', 'planning');

      expect(useThreadStore.getState().threadsById.t1.archived).toBe(false);
      expect(useThreadStore.getState().threadsById.t1.stage).toBe('planning');
    });

    test('rolls back when archive api fails', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, archived: true, stage: 'backlog' } as any] }),
      } as any);
      mockArchiveThread.mockReturnValue(errAsync(new Error('fail')));

      await useThreadStore.getState().unarchiveThread('t1', 'p1', 'planning');

      expect(useThreadStore.getState().threadsById.t1.archived).toBe(true);
    });
  });

  describe('updateThreadStage', () => {
    test('updates stage optimistically and keeps it on success', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      mockUpdateThreadStage.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().updateThreadStage('t1', 'p1', 'in_progress');

      expect(useThreadStore.getState().threadsById.t1.stage).toBe('in_progress');
    });

    test('rolls back stage when api fails', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [{ ...baseThread, stage: 'backlog' } as any] }),
      } as any);
      mockUpdateThreadStage.mockReturnValue(errAsync(new Error('fail')));

      await useThreadStore.getState().updateThreadStage('t1', 'p1', 'in_progress');

      expect(useThreadStore.getState().threadsById.t1.stage).toBe('backlog');
    });
  });

  describe('loadMoreThreads', () => {
    test('appends additional threads to project bucket', async () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
      } as any);
      const t2 = { ...baseThread, id: 't2', title: 'second' };
      mockListThreads.mockReturnValue(okAsync({ threads: [t2], total: 2 }));

      await useThreadStore.getState().loadMoreThreads('p1');

      expect(useThreadStore.getState().threadIdsByProject.p1).toEqual(['t1', 't2']);
      expect(mockListThreads).toHaveBeenCalledWith('p1', false, 50, 1);
    });
  });

  describe('deleteThread', () => {
    test('stops running thread, removes from store, and clears selection', async () => {
      const running = { ...baseThread, status: 'running' as const };
      useThreadStore.setState({
        ...seedThreads({ p1: [running as any] }),
        selectedThreadId: 't1',
        activeThread: running as any,
        threadDataById: { t1: running as any },
      } as any);
      mockStopThread.mockReturnValue(okAsync({ ok: true }));

      await useThreadStore.getState().deleteThread('t1');

      expect(mockStopThread).toHaveBeenCalledWith('t1');
      expect(mockCleanupThreadActor).toHaveBeenCalledWith('t1');
      expect(useThreadStore.getState().threadsById.t1).toBeUndefined();
      expect(useThreadStore.getState().selectedThreadId).toBeNull();
      expect(mockDeleteThread).toHaveBeenCalledWith('t1');
    });
  });

  describe('deleteScratchThread', () => {
    test('removes scratch thread from scratch bucket', async () => {
      const scratch = {
        ...baseThread,
        id: 's1',
        projectId: '',
        isScratch: true,
        status: 'idle' as const,
      };
      useThreadStore.setState({
        threadsById: { s1: scratch as any },
        scratchThreadIds: ['s1'],
        scratchThreadTotal: 1,
        threadIdsByProject: {},
        threadTotalByProject: {},
        threadDataById: { s1: scratch as any },
      } as any);

      await useThreadStore.getState().deleteScratchThread('s1');

      expect(useThreadStore.getState().scratchThreadIds).toEqual([]);
      expect(useThreadStore.getState().threadsById.s1).toBeUndefined();
    });
  });

  describe('appendOptimisticMessage', () => {
    test('appends user message and transitions status on hydrated thread', () => {
      const idle = { ...baseThread, status: 'idle' as const, messages: [] };
      useThreadStore.setState({
        ...seedThreads({ p1: [idle as any] }),
        selectedThreadId: 't1',
        activeThread: idle as any,
        threadDataById: { t1: idle as any },
      } as any);

      useThreadStore.getState().appendOptimisticMessage('t1', 'hello world');

      const payload = useThreadStore.getState().threadDataById.t1;
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].content).toBe('hello world');
      expect(payload.status).toBe('running');
      expect(useThreadStore.getState().threadsById.t1.status).toBe('running');
    });

    test('replaces existing draft user message on idle thread', () => {
      const draft = {
        id: 'draft-1',
        threadId: 't1',
        role: 'user' as const,
        content: 'old draft',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const idle = { ...baseThread, status: 'idle' as const, messages: [draft] };
      useThreadStore.setState({
        ...seedThreads({ p1: [idle as any] }),
        threadDataById: { t1: idle as any },
      } as any);

      useThreadStore.getState().appendOptimisticMessage('t1', 'final prompt');

      const msgs = useThreadStore.getState().threadDataById.t1.messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('final prompt');
    });
  });

  describe('rollbackOptimisticMessage', () => {
    test('removes last user message from payload', () => {
      const userMsg = {
        id: 'u1',
        threadId: 't1',
        role: 'user' as const,
        content: 'oops',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const asstMsg = {
        id: 'a1',
        threadId: 't1',
        role: 'assistant' as const,
        content: 'hi',
        timestamp: '2026-01-01T00:01:00.000Z',
      };
      const thread = {
        ...baseThread,
        status: 'running' as const,
        messages: [userMsg, asstMsg],
        lastUserMessage: userMsg,
      };
      useThreadStore.setState({
        threadDataById: { t1: thread as any },
      } as any);

      useThreadStore.getState().rollbackOptimisticMessage('t1');

      expect(useThreadStore.getState().threadDataById.t1.messages).toEqual([asstMsg]);
    });
  });

  describe('clearProjectThreads', () => {
    test('clears bucket, payloads, and selection when active thread belongs to project', () => {
      useThreadStore.setState({
        ...seedThreads({ p1: [baseThread as any] }),
        selectedThreadId: 't1',
        activeThread: baseThread as any,
        threadDataById: { t1: baseThread as any },
      } as any);

      useThreadStore.getState().clearProjectThreads('p1');

      expect(useThreadStore.getState().threadIdsByProject.p1).toBeUndefined();
      expect(useThreadStore.getState().threadDataById.t1).toBeUndefined();
      expect(useThreadStore.getState().selectedThreadId).toBeNull();
    });
  });

  describe('registerLiveThread / unregisterLiveThread', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) {
        useThreadStore.getState().unregisterLiveThread('t1');
      }
    });

    test('fetches and hydrates thread when not yet loaded', async () => {
      const fetched = { ...baseThread, title: 'Live column' };
      mockGetThread.mockReturnValue(okAsync(fetched));

      await useThreadStore.getState().registerLiveThread('t1');

      expect(useThreadStore.getState().threadDataById.t1.title).toBe('Live column');
      useThreadStore.getState().unregisterLiveThread('t1');
    });

    test('evicts payload after unregister when not selected', async () => {
      const fetched = { ...baseThread, title: 'Live column' };
      mockGetThread.mockReturnValue(okAsync(fetched));
      useThreadStore.setState({ selectedThreadId: null, activeThread: null } as any);

      await useThreadStore.getState().registerLiveThread('t1');
      expect(useThreadStore.getState().threadDataById.t1).toBeDefined();

      useThreadStore.getState().unregisterLiveThread('t1');

      expect(useThreadStore.getState().threadDataById.t1).toBeUndefined();
    });
  });
});
