import type { Collection } from '@tanstack/db';

import type { DataLayer } from './data-layer';
import { createSyncedCollection, type SyncParams } from './synced-collection';

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
  /**
   * Make `rows` the complete synced set of one scope (a project's
   * automations, a thread's comments): synced rows matching `inScope` and not
   * in `rows` are removed; rows outside the scope are untouched.
   */
  replaceWhere(inScope: (row: T) => boolean, rows: readonly T[]): void;
  /** Insert or replace synced rows. */
  upsert(rows: readonly T[]): void;
  /** Synced patch; returning the same reference means "no change". */
  patch(id: string, updater: (row: T) => T): T | null;
  remove(ids: readonly string[]): void;
}

/** A plain copy of `row` without TanStack DB's `$…` virtual props. */
export function stripVirtualProps<T extends Entity>(row: T): T {
  // SAFETY: the copy holds every own field of `row` except TanStack DB's `$…` virtual props,
  // which are not part of T.
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('$'))) as T;
}

export function createEntityStore<T extends Entity>(
  layer: DataLayer,
  name: string,
): EntityStore<T> {
  const synced = new Map<string, T>();
  const plainCopies = new WeakMap<object, T>();
  type Message = Parameters<SyncParams<T>['write']>[0];
  let sync: SyncParams<T> | null = null;

  const collection = createSyncedCollection<T>(
    `${name}:${layer.userId ?? 'anonymous'}:${layer.orgId ?? 'personal'}`,
    (params) => {
      sync = params;
    },
  );

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
    out.push({ type: prev ? 'update' : 'insert', value: next });
  }

  function plainOf(row: T): T {
    const cached = plainCopies.get(row);
    if (cached) return cached;
    const pending = '$hasPendingWrites' in row && row.$hasPendingWrites;
    const plain = (!pending && synced.get(row.id)) || stripVirtualProps(row);
    plainCopies.set(row, plain);
    return plain;
  }

  function replaceMatching(inScope: (row: T) => boolean, rows: readonly T[]): void {
    const keep = new Set(rows.map((row) => row.id));
    commit((out) => {
      for (const [id, row] of [...synced]) {
        if (keep.has(id) || !inScope(row)) continue;
        synced.delete(id);
        out.push({ type: 'delete', key: id });
      }
      for (const row of rows) pushRow(out, row);
    });
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
      replaceMatching(() => true, rows);
    },
    replaceWhere: replaceMatching,
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
          out.push({ type: 'delete', key: id });
        }
      });
    },
  };
}

/**
 * The layer's one entity store named `name`, created on first use and disposed
 * with the layer.
 */
export function ownEntityStore<T extends Entity>(layer: DataLayer, name: string): EntityStore<T> {
  return layer.own(name, () => {
    const data = createEntityStore<T>(layer, name);
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}
