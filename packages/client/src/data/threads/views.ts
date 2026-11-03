import type { Thread, ThreadStage } from '@funny/shared';

import { threadActivityTime } from './order';

/**
 * Derived thread views. Pure functions over canonical rows, so every view
 * places a thread by its current fields (spec: *Derived views stay consistent*).
 */

export type ThreadsByStage = Record<ThreadStage, Thread[]>;

/**
 * Kanban columns: archived threads go to `archived` whatever their stage,
 * the rest by `stage || 'backlog'`. Each column is pinned first, then most
 * recent activity first (the server's list order).
 */
export function groupThreadsByStage(threads: readonly Thread[]): ThreadsByStage {
  const columns: ThreadsByStage = {
    backlog: [],
    planning: [],
    in_progress: [],
    review: [],
    done: [],
    archived: [],
  };
  for (const thread of threads) {
    const stage: ThreadStage = thread.archived ? 'archived' : thread.stage || 'backlog';
    columns[stage]?.push(thread);
  }
  // Same order as `compareThreadsForList`, with each row's activity time
  // computed once instead of re-parsing dates on every comparison.
  const activity = new Map<Thread, number>();
  const timeOf = (thread: Thread) => {
    let time = activity.get(thread);
    if (time === undefined) {
      time = threadActivityTime(thread);
      activity.set(thread, time);
    }
    return time;
  };
  for (const stage of Object.keys(columns) as ThreadStage[]) {
    columns[stage].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || timeOf(b) - timeOf(a));
  }
  return columns;
}

/**
 * IDs listed for a board/list view: one project's list, or every loaded
 * project list plus scratch. Shared-with-me threads are not part of it.
 */
export function boardThreadIds(
  members: Partial<Record<string, string[]>>,
  projectFilter: string | null | undefined,
): string[] {
  if (projectFilter) return members[`project:${projectFilter}`] ?? [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [source, sourceIds] of Object.entries(members)) {
    if (!sourceIds || !(source.startsWith('project:') || source === 'scratch')) continue;
    for (const id of sourceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const EMPTY_THREADS: Thread[] = [];
const orderedCache = new WeakMap<readonly string[], Thread[]>();

/**
 * Rows of `ids` in that order (skipping IDs without a row and duplicates).
 * Memoized per `ids` array: while every row in it keeps its reference the
 * same array is returned, so `memo` components and shallow comparisons skip
 * re-rendering when another list changed.
 */
export function deriveOrderedThreads(
  byId: Readonly<Record<string, Thread | undefined>>,
  ids: readonly string[] | undefined,
): Thread[] {
  if (!ids || ids.length === 0) return EMPTY_THREADS;
  const next: Thread[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const thread = byId[id];
    if (thread) next.push(thread);
  }
  const cached = orderedCache.get(ids);
  if (cached && cached.length === next.length && cached.every((t, i) => t === next[i])) {
    return cached;
  }
  orderedCache.set(ids, next);
  return next;
}

/** Union of every listed ID across the given sources, first occurrence wins. */
export function unionIds(lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const id of list ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const ACTIVITY_RUNNING = new Set(['running', 'waiting', 'pending']);
const ACTIVITY_VISIBLE = new Set([
  ...ACTIVITY_RUNNING,
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

/** How many threads the sidebar Activity section shows. */
const ACTIVITY_LIMIT = 5;

/**
 * Sidebar Activity: threads that ran or are running, not archived and not
 * done. Running threads first, then most recent activity, so a long-running
 * thread with an old `createdAt` never drops out of the top entries.
 */
export function selectActivityThreads(
  threads: readonly Thread[],
  limit = ACTIVITY_LIMIT,
): { threads: Thread[]; totalCount: number } {
  const seen = new Set<string>();
  const visible: Thread[] = [];
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    if (!ACTIVITY_VISIBLE.has(thread.status) || thread.archived || thread.stage === 'done')
      continue;
    seen.add(thread.id);
    visible.push(thread);
  }
  visible.sort((a, b) => {
    const aRunning = a.status === 'running';
    const bRunning = b.status === 'running';
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return threadActivityTime(b) - threadActivityTime(a);
  });
  return { threads: visible.slice(0, limit), totalCount: visible.length };
}
