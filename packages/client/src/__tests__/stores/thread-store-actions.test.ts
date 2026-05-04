import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockSendMessage, mockStopThread, mockApproveTool, mockSearchThreadContent } = vi.hoisted(
  () => ({
    mockSendMessage: vi.fn(),
    mockStopThread: vi.fn(),
    mockApproveTool: vi.fn(),
    mockSearchThreadContent: vi.fn(),
  }),
);

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    sendMessage: mockSendMessage,
    stopThread: mockStopThread,
    approveTool: mockApproveTool,
    searchThreadContent: mockSearchThreadContent,
    getThread: vi.fn(),
    getThreadEvents: vi.fn(),
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
  setCacheInvalidator: vi.fn(),
  invalidateThreadCache: vi.fn(),
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
});
