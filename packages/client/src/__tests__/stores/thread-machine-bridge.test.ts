import type { ThreadWithMessages } from '@funny/shared';
import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetThread, mockGetThreadEvents } = vi.hoisted(() => ({
  mockGetThread: vi.fn(),
  mockGetThreadEvents: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getThread: mockGetThread,
    getThreadEvents: mockGetThreadEvents,
  },
}));

const {
  prefetchThreadData,
  loadThreadData,
  invalidateThreadData,
  isThreadDataPrefetched,
  cleanupThreadActor,
} = await import('@/stores/thread-machine-bridge');

function fakeThread(id: string): ThreadWithMessages {
  return {
    id,
    projectId: 'p1',
    title: 't',
    status: 'completed',
    messages: [],
  } as unknown as ThreadWithMessages;
}

function mockOk(threadId: string) {
  mockGetThread.mockReturnValueOnce(okAsync(fakeThread(threadId)));
  mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));
}

function mockErr(threadId: string, message = 'fetch failed') {
  mockGetThread.mockReturnValueOnce(errAsync({ message } as any));
  mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));
  void threadId;
}

let testCounter = 0;
function uniqueId(label: string) {
  testCounter += 1;
  return `${label}-${testCounter}`;
}

describe('thread-machine-bridge — data actors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    // Best-effort cleanup of any actors created in this test scope.
  });

  describe('prefetchThreadData', () => {
    test('creates actor and reaches loaded after fetch resolves', async () => {
      const id = uniqueId('prefetch-load');
      mockOk(id);

      prefetchThreadData(id);
      expect(isThreadDataPrefetched(id)).toBe(true); // fetching counts as prefetched

      const data = await loadThreadData(id);
      expect(data.thread.id).toBe(id);
      expect(isThreadDataPrefetched(id)).toBe(true);
      // Only one fetch — load reused the in-flight prefetch
      expect(mockGetThread).toHaveBeenCalledTimes(1);

      cleanupThreadActor(id);
    });

    test('isThreadDataPrefetched is false when no actor exists', () => {
      const id = uniqueId('not-exists');
      expect(isThreadDataPrefetched(id)).toBe(false);
    });
  });

  describe('loadThreadData', () => {
    test('reuses loaded actor without re-fetching', async () => {
      const id = uniqueId('reuse');
      mockOk(id);

      const first = await loadThreadData(id);
      expect(first.thread.id).toBe(id);
      expect(mockGetThread).toHaveBeenCalledTimes(1);

      // Second call should reuse cached data, no new fetch.
      const second = await loadThreadData(id);
      expect(second.thread.id).toBe(id);
      expect(mockGetThread).toHaveBeenCalledTimes(1);

      cleanupThreadActor(id);
    });

    test('rejects when fetch fails', async () => {
      const id = uniqueId('reject');
      mockErr(id, 'boom');

      await expect(loadThreadData(id)).rejects.toThrow();
      expect(isThreadDataPrefetched(id)).toBe(false); // failed state, not loaded/fetching

      cleanupThreadActor(id);
    });

    test('coalesces concurrent loads into a single fetch', async () => {
      const id = uniqueId('coalesce');
      mockOk(id);

      const [a, b] = await Promise.all([loadThreadData(id), loadThreadData(id)]);
      expect(a.thread.id).toBe(id);
      expect(b.thread.id).toBe(id);
      expect(mockGetThread).toHaveBeenCalledTimes(1);

      cleanupThreadActor(id);
    });
  });

  describe('invalidateThreadData', () => {
    test('after invalidation, next load triggers a fresh fetch', async () => {
      const id = uniqueId('invalidate');
      mockOk(id);
      await loadThreadData(id);
      expect(mockGetThread).toHaveBeenCalledTimes(1);

      invalidateThreadData(id);
      expect(isThreadDataPrefetched(id)).toBe(false);

      mockOk(id);
      const refetched = await loadThreadData(id);
      expect(refetched.thread.id).toBe(id);
      expect(mockGetThread).toHaveBeenCalledTimes(2);

      cleanupThreadActor(id);
    });

    test('invalidate on unknown thread is a no-op', () => {
      expect(() => invalidateThreadData(uniqueId('unknown'))).not.toThrow();
    });
  });

  describe('cleanupThreadActor', () => {
    test('removes data actor so isThreadDataPrefetched returns false', async () => {
      const id = uniqueId('cleanup');
      mockOk(id);
      await loadThreadData(id);
      expect(isThreadDataPrefetched(id)).toBe(true);

      cleanupThreadActor(id);
      expect(isThreadDataPrefetched(id)).toBe(false);
    });

    test('cleanup on unknown thread is a no-op', () => {
      expect(() => cleanupThreadActor(uniqueId('cleanup-missing'))).not.toThrow();
    });
  });
});
