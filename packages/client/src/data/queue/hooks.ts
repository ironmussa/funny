import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';

import { useDataLayer, useDataQuery } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { getQueueStore, queueListQuery, queueNeedsLoad, type QueueRow } from './store';

/** A thread's queue row (summary + loaded list); re-renders only when that row changes. */
function useQueueRow(threadId: string | undefined): QueueRow | undefined {
  const store = getQueueStore(useDataLayer());
  const id = threadId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('queue:useQueueRow', store.collection, id),
    query: (q) => q.from({ r: store.collection }).where(({ r }) => eq(r.id, id)),
  });
  const row = rows?.[0] as QueueRow | undefined;
  return row ? store.fromRow(row) : undefined;
}

/** Number of follow-ups queued for a thread. */
export function useQueuedCount(threadId: string | undefined): number {
  return useQueueRow(threadId)?.count ?? 0;
}

/**
 * The queue row, fetching the full list while it is behind the summary.
 * Every reader of the same row at the same `rev` shares one request.
 */
export function useLoadedQueue(threadId: string | undefined): {
  row: QueueRow | undefined;
  loading: boolean;
} {
  const layer = useDataLayer();
  const row = useQueueRow(threadId);
  const needsLoad = queueNeedsLoad(row);
  const query = useDataQuery({
    ...queueListQuery(threadId ?? '', row?.rev ?? 0, layer),
    enabled: needsLoad,
  });
  return { row, loading: needsLoad && query.isFetching };
}
