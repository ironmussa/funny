import { BasicIndex, createCollection, type Collection } from '@tanstack/db';

/** The writer TanStack DB hands to a collection's `sync` function. */
export type SyncParams<T extends { id: string }> = Parameters<
  NonNullable<Parameters<typeof createCollection<T, string>>[0]['sync']>['sync']
>[0];

/**
 * A collection whose synced state is written only through an explicit sync
 * writer (list responses, realtime events, confirmations of user writes).
 * `setSync` receives the writer when sync starts and `null` when it stops.
 *
 * Rows are keyed and indexed by id: lookups by id (`where(eq(row.id, …))` live
 * queries, one per rendered row) would otherwise scan the whole collection.
 */
export function createSyncedCollection<T extends { id: string }>(
  id: string,
  setSync: (params: SyncParams<T> | null) => void,
): Collection<T, string> {
  const collection = createCollection<T, string>({
    id,
    getKey: (row) => row.id,
    startSync: true,
    // Rows must outlive their subscribers; the layer's dispose() cleans up.
    gcTime: 0,
    sync: {
      rowUpdateMode: 'full',
      sync: (params) => {
        setSync(params);
        params.markReady();
        return () => setSync(null);
      },
    },
  });
  collection.createIndex((row) => row.id, { indexType: BasicIndex });
  return collection;
}
