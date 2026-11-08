import type { Thread } from '@funny/shared';
import type { Collection } from '@tanstack/db';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import {
  createSyncedCollection,
  type SyncParams as SyncedCollectionParams,
} from '../synced-collection';
import { createThreadListMeta, type ThreadListMetaStore } from './list-meta';
import { fenceFields, mergeIncomingThread, takeFencedFields, type FieldFences } from './merge';

/**
 * The canonical thread rows for one session.
 *
 * The collection's synced state is fed only through the writer below:
 * list/detail responses, realtime events, and confirmations of user writes.
 * User writes are optimistic transactions layered on top (see `actions.ts`).
 * The collection defines no mutation handlers, so a bare
 * `collection.update()` outside an explicit transaction throws.
 *
 * Rows read from the collection carry TanStack DB virtual props
 * (`$hasPendingWrites`, `$origin`, …) as enumerable fields. They must never
 * reach components, API payloads or equality checks: read through
 * `readThread()`, which returns the confirmed object itself when the row has
 * no pending write, so references stay stable, or a memoized plain copy of
 * the optimistic row.
 */

type CollectionRow = Thread & { $hasPendingWrites?: boolean };

const plainCopies = new WeakMap<object, Thread>();

/** Strip TanStack DB virtual props (`$…` keys). Memoized per collection row. */
function toPlainThread(row: Thread): Thread {
  const cached = plainCopies.get(row);
  if (cached) return cached;
  const plain = {} as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!key.startsWith('$')) plain[key] = (row as unknown as Record<string, unknown>)[key];
  }
  plainCopies.set(row, plain as unknown as Thread);
  return plain as unknown as Thread;
}

type SyncParams = SyncedCollectionParams<Thread>;

export interface ThreadsData {
  readonly collection: Collection<Thread, string>;
  readonly meta: ThreadListMetaStore;
  /** Server-confirmed row, without optimistic overlays. */
  getSynced(threadId: string): Thread | undefined;
  /** The visible row (optimistic overlay included), free of virtual props. */
  readThread(threadId: string): Thread | undefined;
  /**
   * Same as `readThread`, for a row object a live query returned. Memoized per
   * row object (live query rows keep their identity while unchanged), so
   * re-reading a large result after a small change stays cheap.
   */
  fromRow(row: Thread): Thread;
  /** Sequence to stamp on a list/detail request that starts now (write fencing). */
  beginRequest(): number;
  /** Merge server rows from a request stamped `startedSeq` by `beginRequest()`. */
  upsertFromServer(rows: readonly Thread[], startedSeq: number): void;
  /** Insert or replace rows from a fresh local source (WS event, create response). Ignores fences. */
  upsertFresh(rows: readonly Thread[]): void;
  /**
   * Apply a synced patch from a realtime event. The updater receives the
   * synced row; returning the same reference means "no change".
   * Returns the new row, or `null` if the row is unknown or unchanged.
   */
  patchSynced(threadId: string, updater: (thread: Thread) => Thread): Thread | null;
  /**
   * Run `fn` with every synced write coalesced into ONE commit at the end
   * (e.g. one realtime flush per animation frame), so live queries and the
   * projection recompute once instead of once per event. Reads of synced
   * rows (`getSynced`) see the held writes immediately; the collection and
   * its views see them at the end of the outermost scope. Nests.
   */
  batchWrites<T>(fn: () => T): T;
  /** Record a confirmed user write: fence its fields, then write them as synced. */
  confirmWrite(threadId: string, fields: Partial<Thread>): void;
  removeRows(threadIds: readonly string[]): void;
  /**
   * Write rows as synced exactly as given (no merge, no fences). Only for
   * seeding fixtures in tests and stories (`testing.ts`).
   */
  importRows(rows: readonly Thread[]): void;
}

function createThreadsData(layer: DataLayer): ThreadsData {
  const synced = new Map<string, Thread>();
  const fences: FieldFences = new Map();
  let sync: SyncParams | null = null;
  const fromRowCache = new WeakMap<object, Thread>();

  const collection = createSyncedCollection<Thread>(
    `threads:${layer.userId ?? 'anonymous'}:${layer.orgId ?? 'personal'}`,
    (params) => {
      sync = params;
    },
  );

  type Message = Parameters<SyncParams['write']>[0];

  /** Messages held by an open `batchWrites` scope, coalesced per row. */
  let held: Map<string, Message> | null = null;
  let batchDepth = 0;

  function messageKey(message: Message): string {
    return message.type === 'delete'
      ? String((message as { key: string }).key)
      : (message as { value: Thread }).value.id;
  }

  /** Fold `next` into the message already held for the same row. */
  function hold(message: Message): void {
    const key = messageKey(message);
    const prev = held!.get(key);
    if (!prev) {
      held!.set(key, message);
    } else if (prev.type === 'insert' && message.type === 'delete') {
      held!.delete(key); // inserted and removed inside the scope: never visible
    } else if (prev.type === 'insert' && message.type === 'update') {
      held!.set(key, { type: 'insert', value: (message as { value: Thread }).value });
    } else if (prev.type === 'delete' && message.type === 'insert') {
      held!.set(key, { type: 'update', value: (message as { value: Thread }).value });
    } else {
      held!.set(key, message);
    }
  }

  function commitMessages(messages: Iterable<Message>): void {
    if (layer.disposed || !sync) return;
    let begun = false;
    for (const message of messages) {
      if (!begun) {
        sync.begin();
        begun = true;
      }
      sync.write(message);
    }
    if (begun) sync.commit();
  }

  /**
   * Apply one synced batch. `collect` pushes messages and updates `synced`;
   * nothing is committed when it pushes none. Inside `batchWrites` the
   * messages are held and committed once when the outermost scope ends.
   * Every write is skipped once the layer is disposed (a late response from
   * the previous session).
   */
  function batch(collect: (out: Message[]) => void): void {
    if (layer.disposed || !sync) return;
    const out: Message[] = [];
    collect(out);
    if (out.length === 0) return;
    if (held) {
      for (const message of out) hold(message);
      return;
    }
    commitMessages(out);
  }

  function pushRow(out: Message[], prev: Thread | undefined, next: Thread): void {
    if (prev === next) return;
    synced.set(next.id, next);
    out.push({ type: prev ? 'update' : 'insert', value: next });
  }

  const data: ThreadsData = {
    collection,
    meta: createThreadListMeta(),
    getSynced: (threadId) => synced.get(threadId),
    fromRow(row) {
      const cached = fromRowCache.get(row);
      if (cached) return cached;
      const pending = (row as CollectionRow).$hasPendingWrites;
      const plain = (!pending && synced.get(row.id)) || toPlainThread(row);
      fromRowCache.set(row, plain);
      return plain;
    },
    readThread(threadId) {
      const row = collection.get(threadId) as CollectionRow | undefined;
      if (!row) return undefined;
      if (!row.$hasPendingWrites) {
        const confirmed = synced.get(threadId);
        if (confirmed) return confirmed;
      }
      return toPlainThread(row);
    },
    beginRequest: () => layer.nextSeq(),

    batchWrites(fn) {
      if (batchDepth === 0) held = new Map();
      batchDepth += 1;
      try {
        return fn();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0) {
          const messages = held!.values();
          held = null;
          commitMessages(messages);
        }
      }
    },

    upsertFromServer(rows, startedSeq) {
      batch((out) => {
        for (const row of rows) {
          const prev = synced.get(row.id);
          const fenced = takeFencedFields(fences, row.id, startedSeq);
          pushRow(out, prev, mergeIncomingThread(prev, row, fenced));
        }
      });
    },

    upsertFresh(rows) {
      batch((out) => {
        for (const row of rows) {
          const prev = synced.get(row.id);
          pushRow(out, prev, mergeIncomingThread(prev, row));
        }
      });
    },

    patchSynced(threadId, updater) {
      const prev = synced.get(threadId);
      if (!prev) return null;
      const next = updater(prev);
      if (next === prev) return null;
      batch((out) => pushRow(out, prev, next));
      return next;
    },

    confirmWrite(threadId, fields) {
      fenceFields(fences, threadId, Object.keys(fields) as (keyof Thread)[], layer.nextSeq());
      const prev = synced.get(threadId);
      if (!prev) return;
      batch((out) => pushRow(out, prev, { ...prev, ...fields }));
    },

    importRows(rows) {
      batch((out) => {
        for (const row of rows) pushRow(out, synced.get(row.id), row);
      });
    },

    removeRows(threadIds) {
      batch((out) => {
        for (const id of threadIds) {
          if (!synced.delete(id)) continue;
          fences.delete(id);
          out.push({ type: 'delete', key: id });
        }
      });
    },
  };
  return data;
}

/** The current session's thread data, created on first use. */
export function getThreadsData(layer: DataLayer = getDataLayer()): ThreadsData {
  return layer.own('threads', () => {
    const data = createThreadsData(layer);
    return {
      value: data,
      // Live queries still mounted from the old session read this collection;
      // they re-subscribe to the new session's collection on their next render.
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}
