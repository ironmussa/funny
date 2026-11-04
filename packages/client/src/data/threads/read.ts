import type { Thread } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer, subscribeDataLayer } from '../runtime';
import type { ThreadSourceKey } from './list-meta';
import { getThreadsData, type ThreadsData } from './store';

/**
 * Imperative (non-React) reads of thread rows and lists, for store actions,
 * event handlers and effect callbacks. React components use `hooks.ts`.
 */

const PROJECT_PREFIX = 'project:';

/** Rows and list order in the shape the pre-migration thread index had. */
export interface ThreadIndexSnapshot {
  threadsById: Record<string, Thread>;
  threadIdsByProject: Record<string, string[]>;
  scratchThreadIds: string[];
  sharedThreadIds: string[];
  threadTotalByProject: Record<string, number>;
  scratchThreadTotal: number;
  sharedThreadTotal: number;
}

interface SnapshotCache {
  snapshot: ThreadIndexSnapshot | null;
}

const snapshotCaches = new WeakMap<ThreadsData, SnapshotCache>();

function cacheFor(data: ThreadsData): SnapshotCache {
  let cache = snapshotCaches.get(data);
  if (!cache) {
    const created: SnapshotCache = { snapshot: null };
    const invalidate = () => {
      created.snapshot = null;
    };
    // Lives as long as the collection; the layer's dispose() cleans both up.
    data.collection.subscribeChanges(invalidate, { includeInitialState: true });
    data.meta.subscribe(invalidate);
    snapshotCaches.set(data, created);
    cache = created;
  }
  return cache;
}

function snapshotRows(data: ThreadsData): Record<string, Thread> {
  const threadsById: Record<string, Thread> = {};
  for (const key of data.collection.keys()) {
    const row = data.readThread(String(key));
    if (row) threadsById[row.id] = row;
  }
  return threadsById;
}

function snapshotProjectLists(data: ThreadsData) {
  const { members, totals } = data.meta.getState();
  const threadIdsByProject: Record<string, string[]> = {};
  const threadTotalByProject: Record<string, number> = {};
  for (const source of Object.keys(members) as ThreadSourceKey[]) {
    if (!source.startsWith(PROJECT_PREFIX)) continue;
    const ids = members[source] ?? [];
    const projectId = source.slice(PROJECT_PREFIX.length);
    threadIdsByProject[projectId] = ids;
    threadTotalByProject[projectId] = totals[source] ?? ids.length;
  }
  return { threadIdsByProject, threadTotalByProject };
}

function buildSnapshot(data: ThreadsData): ThreadIndexSnapshot {
  const { members, totals } = data.meta.getState();
  return {
    threadsById: snapshotRows(data),
    ...snapshotProjectLists(data),
    scratchThreadIds: members.scratch ?? [],
    scratchThreadTotal: totals.scratch ?? 0,
    sharedThreadIds: members.shared ?? [],
    sharedThreadTotal: totals.shared ?? 0,
  };
}

/** Current rows and lists, rebuilt only after a change. */
export function readThreadIndex(layer: DataLayer = getDataLayer()): ThreadIndexSnapshot {
  const data = getThreadsData(layer);
  const cache = cacheFor(data);
  cache.snapshot ??= buildSnapshot(data);
  return cache.snapshot;
}

/** The visible row for a thread, or undefined when this session does not hold it. */
export function readThreadRow(
  threadId: string | null | undefined,
  layer: DataLayer = getDataLayer(),
): Thread | undefined {
  return threadId ? getThreadsData(layer).readThread(threadId) : undefined;
}

const listedSets = new WeakMap<object, Set<string>>();

/**
 * Whether a thread is in any loaded list (project, scratch or shared). A
 * thread opened by URL can have a row without being listed.
 */
export function isThreadListed(threadId: string, layer: DataLayer = getDataLayer()): boolean {
  const members = getThreadsData(layer).meta.getState().members;
  let listed = listedSets.get(members);
  if (!listed) {
    listed = new Set(Object.values(members).flatMap((ids) => ids ?? []));
    listedSets.set(members, listed);
  }
  return listed.has(threadId);
}

/** IDs of the projects whose thread list has been loaded. */
export function listedProjectIds(layer: DataLayer = getDataLayer()): string[] {
  return Object.keys(getThreadsData(layer).meta.getState().members)
    .filter((source) => source.startsWith(PROJECT_PREFIX))
    .map((source) => source.slice(PROJECT_PREFIX.length));
}

/** Whether a project's thread list has been loaded (an empty list counts). */
export function isProjectListed(projectId: string, layer: DataLayer = getDataLayer()): boolean {
  return `${PROJECT_PREFIX}${projectId}` in getThreadsData(layer).meta.getState().members;
}

/** IDs listed for a project, in server order. */
export function listedProjectThreadIds(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): string[] {
  return getThreadsData(layer).meta.getState().members[`${PROJECT_PREFIX}${projectId}`] ?? [];
}

/**
 * Call `listener` with the current `{ projectId → ids }` lists now and after
 * every list change, following session swaps (the new layer starts empty).
 */
export function subscribeProjectLists(
  listener: (threadIdsByProject: Record<string, string[]>) => void,
): () => void {
  let unsubscribeMeta: () => void = () => {};
  const attach = () => {
    unsubscribeMeta();
    const layer = getDataLayer();
    const meta = getThreadsData(layer).meta;
    listener(readThreadIndex(layer).threadIdsByProject);
    let previousMembers = meta.getState().members;
    unsubscribeMeta = meta.subscribe((state) => {
      if (state.members === previousMembers) return;
      previousMembers = state.members;
      listener(readThreadIndex(layer).threadIdsByProject);
    });
  };
  attach();
  const unsubscribeLayer = subscribeDataLayer(attach);
  return () => {
    unsubscribeLayer();
    unsubscribeMeta();
  };
}
