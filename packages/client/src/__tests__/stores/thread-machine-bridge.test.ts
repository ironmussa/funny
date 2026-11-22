import { describe, test, expect, vi, beforeEach, afterEach, mock } from 'bun:test';

import type { ThreadWithMessages } from '@funny/shared';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { saveThreadScrollPosition } from '@/lib/thread-scroll-position';

import { buildMessage } from '../helpers/builders-stores';

const { mockGetThread, mockGetThreadEvents } = (() => ({
  mockGetThread: vi.fn(),
  mockGetThreadEvents: vi.fn(),
}))();

mock.module('@/lib/api', () => ({
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
  transitionThreadStatus,
} = await import('@/stores/thread-machine-bridge');

function fakeThreadWindow(
  id: string,
  windowStart: number,
  count: number,
  total: number,
): ThreadWithMessages {
  return buildThreadWithMessages({
    id,
    messages: Array.from({ length: count }, (_, index) => {
      const messageIndex = windowStart + index;
      return buildMessage({
        id: `m${messageIndex}`,
        threadId: id,
        role: 'assistant',
        content: `message ${messageIndex}`,
        timestamp: `2026-01-01T00:00:${String(messageIndex).padStart(2, '0')}.000Z`,
        toolCalls: [],
      });
    }),
    total,
    windowStart,
    hasMore: windowStart > 0,
    hasMoreAfter: windowStart + count < total,
  });
}

function mockOk(threadId: string) {
  mockGetThread.mockReturnValueOnce(okAsync(buildThreadWithMessages({ id: threadId })));
  mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));
}

function mockErr(threadId: string, message = 'fetch failed') {
  mockGetThread.mockReturnValueOnce(errAsync({ message }));
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

    test('refetches a loaded actor when its cached window misses the stored scroll position', async () => {
      const id = uniqueId('scroll-window');
      mockGetThread.mockReturnValueOnce(okAsync(fakeThreadWindow(id, 50, 5, 100)));
      mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));

      const first = await loadThreadData(id);
      expect(first.thread.windowStart).toBe(50);

      saveThreadScrollPosition(id, {
        progress: 0.2,
        anchor: { key: 'm20', offsetFromViewportTop: 24 },
      });
      mockGetThread.mockReturnValueOnce(okAsync(fakeThreadWindow(id, 18, 5, 100)));
      mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));

      const refetched = await loadThreadData(id);
      expect(mockGetThread).toHaveBeenCalledTimes(2);
      expect(refetched.thread.windowStart).toBe(18);
      expect(refetched.thread.messages.map((message) => message.id)).toContain('m20');
      expect(mockGetThread.mock.calls[1][3]).toMatchObject({
        messageProgress: 0.2,
        messageAnchorId: 'm20',
      });

      cleanupThreadActor(id);
    });

    test('does not send a stale visible anchor when the stored position is bottom', async () => {
      const id = uniqueId('bottom-scroll');
      saveThreadScrollPosition(id, {
        progress: 1,
        anchor: { key: 'm20', offsetFromViewportTop: 24 },
      });
      mockOk(id);

      await loadThreadData(id);

      expect(mockGetThread.mock.calls.at(-1)?.[3]).toEqual({
        messageProgress: 1,
      });

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

    test('regression #208: more than 5 INVALIDATEs during a fetch still resolve the load', async () => {
      // A busy thread emits a WS event (and an INVALIDATE) for every message,
      // tool call and status change. Each one used to restart the fetch, and
      // after 5 restarts the load was rejected and the thread failed to open.
      const id = uniqueId('invalidate-during-fetch');

      let resolveFetch: (v: ThreadWithMessages) => void = () => {};
      const pendingFetch = new Promise<ThreadWithMessages>((res) => {
        resolveFetch = res;
      });
      mockGetThread.mockReturnValueOnce(ResultAsync.fromPromise(pendingFetch, (e) => e));
      mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));

      const loadPromise = loadThreadData(id);
      await new Promise((r) => setTimeout(r, 10));

      for (let i = 0; i < 12; i += 1) invalidateThreadData(id);
      resolveFetch(buildThreadWithMessages({ id }));

      const data = await loadPromise;
      expect(data.thread.id).toBe(id);
      // The in-flight fetch was kept, not restarted.
      expect(mockGetThread).toHaveBeenCalledTimes(1);
      // The snapshot missed events, so it is not served from cache again.
      expect(isThreadDataPrefetched(id)).toBe(false);

      mockOk(id);
      await loadThreadData(id);
      expect(mockGetThread).toHaveBeenCalledTimes(2);
      expect(isThreadDataPrefetched(id)).toBe(true);

      cleanupThreadActor(id);
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

  describe('transitionThreadStatus', () => {
    test('judges each event against the status it is given, not a remembered one', () => {
      const id = uniqueId('status');
      // The thread completes...
      expect(transitionThreadStatus(id, { type: 'COMPLETE' }, 'running')).toBe('completed');
      // ...then a list refresh says it is running again (a follow-up sent from
      // another tab). The next event must apply to `running`: a bridge that
      // still remembered `completed` dropped it and reverted the row.
      expect(transitionThreadStatus(id, { type: 'SET_STATUS', status: 'waiting' }, 'running')).toBe(
        'waiting',
      );
    });

    test('applying the same event to the row and to the loaded payload agrees', () => {
      const id = uniqueId('status');
      const event = { type: 'START' } as const;
      expect(transitionThreadStatus(id, event, 'completed')).toBe('running');
      expect(transitionThreadStatus(id, event, 'completed')).toBe('running');
    });

    test('a failed sandbox thread follows the server back to setting_up, then pending', () => {
      const id = uniqueId('status');
      const settingUp = transitionThreadStatus(
        id,
        { type: 'SET_STATUS', status: 'setting_up' },
        'failed',
      );
      expect(settingUp).toBe('setting_up');
      expect(transitionThreadStatus(id, { type: 'SETUP_COMPLETE' }, settingUp)).toBe('pending');
    });

    test('an event the status does not accept leaves it unchanged', () => {
      const id = uniqueId('status');
      expect(transitionThreadStatus(id, { type: 'SETUP_COMPLETE' }, 'running')).toBe('running');
      expect(transitionThreadStatus(id, null, 'running')).toBe('running');
    });
  });
});
