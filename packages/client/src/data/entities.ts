import { createCollection, type Collection } from '@tanstack/db';

import type { DataLayer } from './data-layer';

/**
 * A server-backed entity collection with an explicit sync writer, for
 * entities that come from a complete list endpoint (projects, templates, …).
 *
 * Same contract as the threads collection (`threads/store.ts`), without its
 * list membership and write fences: synced state changes only through the
 * writer below (list responses, realtime events, confirmations of user
 * writes); user writes are optimistic transactions on top
 * (`optimistic-write.ts`). The collection defines no mutation handlers, so a
 * bare `collection.update()` outside a transaction throws.
 *
 * Rows read from the collection carry TanStack DB virtual props (`$…`) as
 * enumerable fields; `read()` / `fromRow()` return plain objects, the
 * confirmed object itself when the row has no pending write.
 */

type Entity = { id: string };
type CollectionRow<T> = T & { $hasPendingWrites?: boolean };

export interface EntityStore<T extends Entity> {
  readonly collection: Collection<T, string>;
  /** Server-confirmed row, without optimistic overlays. */
  getSynced(id: string): T | undefined;
  /** The visible row (optimistic overlay included), free of virtual props. */
  read(id: string): T | undefined;
  /** Same as `read`, for a row object a live query returned. Memoized per row. */
  fromRow(row: T): T;
  /** Make `rows` the complete synced set: rows not in it are removed. */
  replaceAll(rows: readonly T[]): void;
  /** Insert or replace synced rows. */
  upsert(rows: readonly T[]): void;
  /** Synced patch; returning the same reference means "no change". */
  patch(id: string, updater: (row: T) => T): T | null;
  remove(ids: readonly string[]): void;
}

function stripVirtualProps<T>(row: T): T {
  const plain = {} as Record<string, unknown>;
  for (const key of Object.keys(row as object)) {
    if (!key.startsWith('$')) plain[key] = (row as Record<string, unknown>)[key];
  }
  return plain as T;
}

export function createEntityStore<T extends Entity>(
  layer: DataLayer,
  name: string,
): EntityStore<T> {
  const synced = new Map<string, T>();
  const plainCopies = new WeakMap<object, T>();
  type SyncParams = Parameters<
    NonNullable<Parameters<typeof createCollection<T, string>>[0]['sync']>['sync']
  >[0];
  type Message = Parameters<SyncParams['write']>[0];
  let sync: SyncParams | null = null;

  const collection = createCollection<T, string>({
    id: `${name}:${layer.userId ?? 'anonymous'}:${layer.orgId ?? 'personal'}`,
    getKey: (row) => row.id,
    startSync: true,
    // Rows must outlive their subscribers; the layer's dispose() cleans up.
    gcTime: 0,
    sync: {
      rowUpdateMode: 'full',
      sync: (params) => {
        sync = params;
        params.markReady();
        return () => {
          sync = null;
        };
      },
    },
  });

  /** Commit one synced batch; skipped once the layer is disposed (late response). */
  function commit(collect: (out: Message[]) => void): void {
    if (layer.disposed || !sync) return;
    const out: Message[] = [];
    collect(out);
    if (out.length === 0) return;
    sync.begin();
    for (const message of out) sync.write(message);
    sync.commit();
  }

  function pushRow(out: Message[], next: T): void {
    const prev = synced.get(next.id);
    if (prev === next) return;
    synced.set(next.id, next);
    out.push({ type: prev ? 'update' : 'insert', value: next } as Message);
  }

  function plainOf(row: T): T {
    const cached = plainCopies.get(row as object);
    if (cached) return cached;
    const pending = (row as CollectionRow<T>).$hasPendingWrites;
    const plain = (!pending && synced.get(row.id)) || stripVirtualProps(row);
    plainCopies.set(row as object, plain);
    return plain;
  }

  return {
    collection,
    getSynced: (id) => synced.get(id),
    read(id) {
      const row = collection.get(id);
      return row ? plainOf(row) : undefined;
    },
    fromRow: plainOf,
    replaceAll(rows) {
      const keep = new Set(rows.map((row) => row.id));
      commit((out) => {
        for (const id of [...synced.keys()]) {
          if (keep.has(id)) continue;
          synced.delete(id);
          out.push({ type: 'delete', key: id } as Message);
        }
        for (const row of rows) pushRow(out, row);
      });
    },
    upsert(rows) {
      commit((out) => {
        for (const row of rows) pushRow(out, row);
      });
    },
    patch(id, updater) {
      const prev = synced.get(id);
      if (!prev) return null;
      const next = updater(prev);
      if (next === prev) return null;
      commit((out) => pushRow(out, next));
      return next;
    },
    remove(ids) {
      commit((out) => {
        for (const id of ids) {
          if (!synced.delete(id)) continue;
          out.push({ type: 'delete', key: id } as Message);
        }
      });
    },
  };
}
