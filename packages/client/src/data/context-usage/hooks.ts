import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import type { ContextUsage } from '@/lib/context-usage-types';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { getContextUsageStore, type ContextUsageRow } from './store';

/** Context-window usage of one thread; re-renders only when that thread's row changes. */
export function useContextUsage(threadId: string | undefined): ContextUsage | undefined {
  const store = getContextUsageStore(useDataLayer());
  const id = threadId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('context-usage:useContextUsage', store.collection, id),
    query: (q) => q.from({ u: store.collection }).where(({ u }) => eq(u.id, id)),
  });
  const row = rows?.[0] as ContextUsageRow | undefined;
  return useMemo(() => (row ? store.fromRow(row) : undefined), [row, store]);
}
