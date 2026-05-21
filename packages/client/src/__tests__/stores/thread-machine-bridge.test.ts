import type { ThreadWithMessages } from '@funny/shared';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
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

    test('regresión: loadThreadData no se cuelga si INVALIDATE llega durante fetching', async () => {
      // Reproduce el bug observado: cuando el usuario clickea un hilo y un
      // WS event para ese mismo hilo llega mientras está en `fetching`, el
      // actor transita `fetching → unloaded` y el `waitFor(loaded || failed)`
      // original quedaba colgado para siempre (timeout: Infinity). Eso dejaba
      // `selectingThreadId` stuck y los siguientes clicks no-op.
      const id = uniqueId('invalidate-during-fetch');

      // Primer fetch: deferred — controlamos cuándo (si) resuelve.
      let resolveFirst: (v: ThreadWithMessages) => void = () => {};
      const firstFetch = new Promise<ThreadWithMessages>((res) => {
        resolveFirst = res;
      });
      mockGetThread.mockReturnValueOnce(ResultAsync.fromPromise(firstFetch, (e: any) => e as any));
      mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));

      // Segundo fetch (después del re-LOAD): resuelve inmediato.
      mockGetThread.mockReturnValueOnce(okAsync(fakeThread(id)));
      mockGetThreadEvents.mockReturnValueOnce(okAsync({ events: [] }));

      const loadPromise = loadThreadData(id);

      // Dar un tick para que el actor entre en `fetching`.
      await new Promise((r) => setTimeout(r, 10));

      // Simular llegada de WS event: invalida durante fetch.
      invalidateThreadData(id);

      // Liberar el primer fetch — ya no debería importar (el invoke fue
      // descartado al transitar a `unloaded`), pero lo resolvemos para
      // confirmar que el fix no depende de que el primer fetch resuelva.
      resolveFirst(fakeThread(id));

      // Race contra un timeout de seguridad. Antes del fix, loadPromise
      // hangueaba para siempre y este test colgaba hasta el timeout de Vitest.
      const winner = await Promise.race([
        loadPromise.then((data) => ({ kind: 'resolved' as const, data })),
        new Promise<{ kind: 'hung' }>((res) => setTimeout(() => res({ kind: 'hung' }), 2000)),
      ]);

      expect(winner.kind).toBe('resolved');
      if (winner.kind === 'resolved') {
        expect(winner.data.thread.id).toBe(id);
      }
      // Después del re-LOAD, debería haber dos llamadas a getThread.
      expect(mockGetThread).toHaveBeenCalledTimes(2);

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
});
