import type { Job, Watcher } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import type { EntityStore } from '../entities';
import { useDataLayer } from '../hooks';
import { getJobsData, getWatchersData } from './store';

/**
 * React reads of jobs and watchers, keyed by id (the shape the activity panel
 * and `watcher-utils` selectors take). Unchanged rows keep their reference.
 */

const EMPTY = {};

function toById<T extends { id: string }>(
  rows: readonly T[] | undefined,
  data: EntityStore<T>,
): Record<string, T> {
  if (!rows || rows.length === 0) return EMPTY as Record<string, T>;
  return Object.fromEntries(rows.map((row) => [row.id, data.fromRow(row)]));
}

function useById<T extends { id: string }>(data: EntityStore<T>): Record<string, T> {
  const { data: rows } = useLiveQuery((q) => q.from({ row: data.collection }));
  return useMemo(() => toById(rows as T[] | undefined, data), [rows, data]);
}

function useByIdForThread<T extends { id: string; threadId: string }>(
  data: EntityStore<T>,
  threadId: string,
): Record<string, T> {
  const { data: rows } = useLiveQuery((q) =>
    q.from({ row: data.collection }).where(({ row }) => eq(row.threadId, threadId)),
  );
  return useMemo(() => toById(rows as T[] | undefined, data), [rows, data]);
}

export function useJobsById(): Record<string, Job> {
  return useById(getJobsData(useDataLayer()));
}

export function useWatchersById(): Record<string, Watcher> {
  return useById(getWatchersData(useDataLayer()));
}

/** One thread's jobs, keyed by id. */
export function useThreadJobsById(threadId: string): Record<string, Job> {
  return useByIdForThread(getJobsData(useDataLayer()), threadId);
}

/** One thread's watchers, keyed by id. */
export function useThreadWatchersById(threadId: string): Record<string, Watcher> {
  return useByIdForThread(getWatchersData(useDataLayer()), threadId);
}
