import type { Thread } from '@funny/shared';
import { eq, inArray } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';
import { useStore } from 'zustand';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import type { ThreadListMetaState, ThreadSourceKey } from './list-meta';
import { getThreadsData, type ThreadsData } from './store';
import { boardThreadIds, deriveOrderedThreads, unionIds } from './views';

/**
 * React read API for thread rows. Every hook is a live query over the
 * session's threads collection, so optimistic writes, confirmations and
 * realtime changes reach every view without a re-fetch. Returned rows are
 * plain `Thread`s (no virtual props); unchanged rows and unchanged lists
 * keep their references across renders.
 */

const EMPTY_IDS: string[] = [];
const EMPTY_BY_PROJECT: Record<string, Thread[]> = {};
const PROJECT_PREFIX = 'project:';

function useThreadsData(): ThreadsData {
  return getThreadsData(useDataLayer());
}

/** Same IDs → same array, so a live query's identity only changes with the membership. */
function useStableIds(ids: readonly string[]): string[] {
  const key = ids.join('\n');
  return useMemo(() => (key ? key.split('\n') : EMPTY_IDS), [key]);
}

function useMembers(data: ThreadsData): ThreadListMetaState['members'] {
  return useStore(data.meta, (state) => state.members);
}

/** Live rows for `ids`, keyed by id. */
function useRowsById(data: ThreadsData, ids: string[]): Record<string, Thread> {
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('threads:by-ids', data.collection, ids),
    query: (q) =>
      q.from({ thread: data.collection }).where(({ thread }) => inArray(thread.id, ids)),
  });
  return useMemo(() => {
    const byId: Record<string, Thread> = {};
    for (const row of rows ?? []) {
      const thread = data.fromRow(row as Thread);
      byId[thread.id] = thread;
    }
    return byId;
  }, [rows, data]);
}

function useSourceThreads(source: ThreadSourceKey): Thread[] {
  const data = useThreadsData();
  const sourceIds = useMembers(data)[source] ?? EMPTY_IDS;
  const ids = useStableIds(sourceIds);
  const byId = useRowsById(data, ids);
  return useMemo(() => deriveOrderedThreads(byId, sourceIds), [byId, sourceIds]);
}

/** Reactive lookup for a single thread. */
export function useThreadById(threadId: string | null | undefined): Thread | undefined {
  const data = useThreadsData();
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('threads:by-id', data.collection, threadId ?? null),
    query: (q) =>
      threadId
        ? q.from({ thread: data.collection }).where(({ thread }) => eq(thread.id, threadId))
        : null,
  });
  const row = rows?.[0] as Thread | undefined;
  return row ? data.fromRow(row) : undefined;
}

/** Ordered rows of a project's list (server order). */
export function useThreadsForProject(projectId: string): Thread[] {
  return useSourceThreads(`${PROJECT_PREFIX}${projectId}` as ThreadSourceKey);
}

/** Ordered scratch list (most recent first). */
export function useScratchThreads(): Thread[] {
  return useSourceThreads('scratch');
}

/** Ordered "shared with me" list. */
export function useSharedThreads(): Thread[] {
  return useSourceThreads('shared');
}

const byProjectCache = new WeakMap<object, Record<string, Thread[]>>();

/**
 * `{ projectId → Thread[] }` for every loaded project list. The record and
 * each per-project array keep their references while nothing in them
 * changed. Prefer `useThreadsForProject` for a single project.
 */
export function useThreadsByProject(): Record<string, Thread[]> {
  const data = useThreadsData();
  const members = useMembers(data);
  const projectSources = useMemo(
    () => (Object.keys(members) as ThreadSourceKey[]).filter((s) => s.startsWith(PROJECT_PREFIX)),
    [members],
  );
  const ids = useStableIds(
    useMemo(() => unionIds(projectSources.map((s) => members[s])), [projectSources, members]),
  );
  const byId = useRowsById(data, ids);

  return useMemo(() => {
    if (projectSources.length === 0) return EMPTY_BY_PROJECT;
    const next: Record<string, Thread[]> = {};
    for (const source of projectSources) {
      const projectId = source.slice(PROJECT_PREFIX.length);
      if (projectId) next[projectId] = deriveOrderedThreads(byId, members[source]);
    }
    const prev = byProjectCache.get(members);
    if (prev) {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
        return prev;
      }
    }
    byProjectCache.set(members, next);
    return next;
  }, [byId, members, projectSources]);
}

/**
 * Loaded threads for the board and list views: one project's list, or every
 * loaded project plus scratch (not shared-with-me).
 */
export function useLoadedThreads(projectFilter?: string | null): Thread[] {
  const data = useThreadsData();
  const members = useMembers(data);
  const listed = useMemo(() => boardThreadIds(members, projectFilter), [members, projectFilter]);
  const ids = useStableIds(listed);
  const byId = useRowsById(data, ids);
  return useMemo(() => deriveOrderedThreads(byId, ids), [byId, ids]);
}

const totalsCache = new WeakMap<object, Record<string, number>>();

/** Server totals per loaded project list, `{ projectId → total }`. */
export function useProjectListTotals(): Record<string, number> {
  const data = useThreadsData();
  const totals = useStore(data.meta, (state) => state.totals);
  return useMemo(() => {
    const cached = totalsCache.get(totals);
    if (cached) return cached;
    const byProject: Record<string, number> = {};
    for (const [source, total] of Object.entries(totals)) {
      if (source.startsWith(PROJECT_PREFIX) && total !== undefined) {
        byProject[source.slice(PROJECT_PREFIX.length)] = total;
      }
    }
    totalsCache.set(totals, byProject);
    return byProject;
  }, [totals]);
}
