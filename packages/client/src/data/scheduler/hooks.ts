import { useLiveQuery } from '@tanstack/react-db';
import { useCallback, useMemo, useState } from 'react';

import type { SchedulerRun } from '@/lib/api/scheduler';

import { useDataLayer, useDataQuery } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { getSchedulerData, refreshScheduler, schedulerRunsQuery, type SchedulerRow } from './store';

/** The scheduler queue, most recent event first, fetched when a reader mounts. */
export function useSchedulerQueue(): {
  runs: SchedulerRun[];
  loading: boolean;
  error: string | null;
} {
  const layer = useDataLayer();
  const data = getSchedulerData(layer);
  const query = useDataQuery(schedulerRunsQuery(layer));
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('scheduler:useSchedulerQueue', data.collection),
    query: (q) => q.from({ run: data.collection }),
  });
  const runs = useMemo(
    () =>
      (rows ?? [])
        .map((row) => data.fromRow(row as SchedulerRow))
        .sort((a, b) => b.lastEventAtMs - a.lastEventAtMs),
    [rows, data],
  );
  return { runs, loading: query.isFetching, error: query.error?.message ?? null };
}

/** "Tick now" for the scheduler view: one request at a time, keeping its last error. */
export function useSchedulerRefresh(): {
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const result = await refreshScheduler();
    setError(result.isErr() ? result.error.message : null);
    setRefreshing(false);
  }, [refreshing]);
  return { refreshing, error, refresh };
}
