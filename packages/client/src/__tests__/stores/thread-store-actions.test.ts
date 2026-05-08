import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockSendMessage,
  mockStopThread,
  mockApproveTool,
  mockSearchThreadContent,
  mockGetThread,
  mockGetThreadEvents,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockStopThread: vi.fn(),
  mockApproveTool: vi.fn(),
  mockSearchThreadContent: vi.fn(),
  mockGetThread: vi.fn(),
  mockGetThreadEvents: vi.fn(),
}));

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    sendMessage: mockSendMessage,
    stopThread: mockStopThread,
    approveTool: mockApproveTool,
    searchThreadContent: mockSearchThreadContent,
    getThread: mockGetThread,
    getThreadEvents: mockGetThreadEvents,
    listThreads: vi.fn(),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    archiveThread: vi.fn(),
    getThreadMessages: vi.fn(),
    renameThread: vi.fn(),
    pinThread: vi.fn(),
    updateThreadStage: vi.fn(),
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
  cleanupThreadActor: vi.fn(),
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
}));

import { useThreadStore } from '@/stores/thread-store';

describe('thread store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      useThreadStore.setState({
        activeThread: { ...(baseThread as any), messages },
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
});
