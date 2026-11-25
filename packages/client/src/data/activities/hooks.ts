import type { Activity } from '@funny/shared';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { getActivitiesData, getActivityProgressData } from './store';

/**
 * React reads of the user's activities. The list is ordered for the panel:
 * running first, then finished ones newest first. Unchanged rows keep their
 * reference.
 */

const EMPTY: Activity[] = [];
const EMPTY_PROGRESS: Record<string, number> = {};

function endedOrStarted(a: Activity): string {
  return a.endedAt ?? a.startedAt;
}

function sortActivities(rows: readonly Activity[]): Activity[] {
  return [...rows].sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1;
    const bRunning = b.status === 'running' ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return endedOrStarted(b).localeCompare(endedOrStarted(a));
  });
}

export function useActivities(): Activity[] {
  const data = getActivitiesData(useDataLayer());
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('activities:list', data.collection),
    query: (q) => q.from({ row: data.collection }),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return EMPTY;
    return sortActivities(rows.map((row) => data.fromRow(row)));
  }, [rows, data]);
}

/** Transient progress percentages of running activities, by id. */
export function useActivityProgress(): Record<string, number> {
  const data = getActivityProgressData(useDataLayer());
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('activities:progress', data.collection),
    query: (q) => q.from({ row: data.collection }),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return EMPTY_PROGRESS;
    return Object.fromEntries(rows.map((row) => [row.id, row.percent]));
  }, [rows]);
}

/** The footer counters: running activities, and failed or interrupted ones not dismissed. */
export function useActivityCounts(): { running: number; failed: number } {
  const activities = useActivities();
  return useMemo(() => {
    let running = 0;
    let failed = 0;
    for (const a of activities) {
      if (a.status === 'running') running += 1;
      else if (a.status === 'failed' || a.status === 'interrupted') failed += 1;
    }
    return { running, failed };
  }, [activities]);
}
