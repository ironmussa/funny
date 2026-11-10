import type { QueuedMessage } from '@funny/shared';

import { threadsApi } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

const log = createClientLogger('PromptInputQueue');

/**
 * Each thread's follow-up queue, one row per thread id.
 *
 * The summary (`count`, `next`) arrives from several places: `queue:update`
 * events, the thread detail, and the response of a send the server queued.
 * Every summary change bumps `rev`. The full list (`messages`) is fetched
 * lazily, by the composer, whenever it is behind the summary
 * (`loadedRev !== rev`); a list that comes back after a newer summary landed
 * is dropped, so a slow fetch cannot show a queue the server already changed.
 */
export interface QueueRow {
  id: string;
  count: number;
  /** Content of the next queued message, when known. */
  next?: string;
  /** The full queue, as of `loadedRev`. Absent until first fetched. */
  messages?: QueuedMessage[];
  rev: number;
  loadedRev: number;
}

export function getQueueStore(layer: DataLayer = getDataLayer()): EntityStore<QueueRow> {
  return layer.own('queue', () => {
    const store = createEntityStore<QueueRow>(layer, 'queue');
    return {
      value: store,
      dispose: () => {
        void store.collection.cleanup({ dependents: true }).catch(() => undefined);
      },
    };
  });
}

/** True when the list must be (re)fetched to match the summary. */
export function queueNeedsLoad(row: QueueRow | undefined): row is QueueRow {
  return !!row && row.count > 0 && row.loadedRev !== row.rev;
}

/** Record the server's queue summary for a thread. */
export function applyQueueSummary(
  threadId: string,
  count: number,
  next: string | undefined,
  layer: DataLayer = getDataLayer(),
): void {
  const store = getQueueStore(layer);
  const prev = store.getSynced(threadId);
  const nextContent = count > 0 ? next : undefined;
  if (prev && prev.count === count && prev.next === nextContent) return;
  const rev = (prev?.rev ?? 0) + 1;
  // An empty queue has nothing left to load.
  if (count === 0) {
    store.upsert([{ id: threadId, count: 0, messages: [], rev, loadedRev: rev }]);
    return;
  }
  store.upsert([
    { ...prev, id: threadId, count, next: nextContent, rev, loadedRev: prev?.loadedRev ?? 0 },
  ]);
}

/** Record a new queue length the server reported; the next message is unchanged. */
export function applyQueueCount(
  threadId: string,
  count: number,
  layer: DataLayer = getDataLayer(),
): void {
  applyQueueSummary(threadId, count, getQueueStore(layer).getSynced(threadId)?.next, layer);
}

/**
 * Record the summary from a thread detail. A row this session already holds
 * came from later events, so it wins over a (possibly prefetched) detail.
 */
export function seedQueueSummary(
  threadId: string,
  count: number,
  next: string | undefined,
  layer: DataLayer = getDataLayer(),
): void {
  if (getQueueStore(layer).getSynced(threadId)) return;
  applyQueueSummary(threadId, count, next, layer);
}

/** The full-list request for a row at `rev`. Writes the result unless the summary moved on. */
export function queueListQuery(threadId: string, rev: number, layer: DataLayer = getDataLayer()) {
  return {
    queryKey: ['thread-queue', threadId, rev] as const,
    queryFn: async (): Promise<number> => {
      const messages = await unwrapResult(threadsApi.listQueue(threadId)).catch((error) => {
        log.warn('queue fetch failed', { threadId, error: String(error) });
        throw error;
      });
      log.info('queue fetched', { threadId, messageCount: String(messages.length) });
      const store = getQueueStore(layer);
      const row = store.getSynced(threadId);
      if (row && row.rev === rev) {
        store.upsert([{ ...row, messages, next: messages[0]?.content, loadedRev: rev }]);
      }
      return messages.length;
    },
  };
}

/** Record a queued message the server confirmed as edited. */
export function patchQueuedMessage(
  threadId: string,
  messageId: string,
  content: string,
  layer: DataLayer = getDataLayer(),
): void {
  getQueueStore(layer).patch(threadId, (row) => {
    if (!row.messages) return row;
    const messages = row.messages.map((m) => (m.id === messageId ? { ...m, content } : m));
    return { ...row, messages, next: messages[0]?.content ?? row.next };
  });
}

/** Record a queued message the server confirmed as cancelled, with its new queue length. */
export function removeQueuedMessage(
  threadId: string,
  messageId: string,
  count: number,
  layer: DataLayer = getDataLayer(),
): void {
  const store = getQueueStore(layer);
  const row = store.getSynced(threadId);
  if (!row || count === 0) {
    applyQueueSummary(threadId, count, undefined, layer);
    return;
  }
  const messages = (row.messages ?? []).filter((m) => m.id !== messageId);
  // The list stays current: the server only removed this message.
  const rev = row.rev + 1;
  store.upsert([
    {
      ...row,
      count,
      next: messages[0]?.content,
      messages,
      rev,
      loadedRev: row.loadedRev === row.rev ? rev : row.loadedRev,
    },
  ]);
}

/** The queue length of a thread, for imperative code. */
export function readQueuedCount(threadId: string, layer: DataLayer = getDataLayer()): number {
  return getQueueStore(layer).getSynced(threadId)?.count ?? 0;
}
