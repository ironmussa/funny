import type { Thread } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import {
  clearSource,
  projectSource,
  setSourceMembers,
  type ThreadListMetaStore,
  type ThreadSourceKey,
} from './list-meta';
import { readThreadIndex, type ThreadIndexSnapshot } from './read';
import { getThreadsData, type ThreadsData } from './store';

/**
 * Seeding helpers for tests and stories. Fixtures are written in the shape
 * of the pre-migration thread index (`threadsById` + list arrays), which is
 * how most fixtures were authored; they land in the threads collection and
 * list metadata, the only place thread rows live.
 */

export type ThreadIndexFields = Partial<ThreadIndexSnapshot>;

const INDEX_KEYS = [
  'threadsById',
  'threadIdsByProject',
  'scratchThreadIds',
  'sharedThreadIds',
  'threadTotalByProject',
  'scratchThreadTotal',
  'sharedThreadTotal',
] as const satisfies readonly (keyof ThreadIndexSnapshot)[];

type IndexKey = (typeof INDEX_KEYS)[number];

function replaceRows(data: ThreadsData, threadsById: Record<string, Thread>): void {
  const rows = Object.values(threadsById);
  const keep = new Set(rows.map((row) => row.id));
  const stale = [...data.collection.keys()].map(String).filter((id) => !keep.has(id));
  if (stale.length) data.removeRows(stale);
  data.importRows(rows);
}

function replaceProjectLists(
  meta: ThreadListMetaStore,
  threadIdsByProject: Record<string, string[]>,
  totals: Record<string, number> = {},
): void {
  for (const source of Object.keys(meta.getState().members) as ThreadSourceKey[]) {
    if (source.startsWith('project:')) clearSource(meta, source);
  }
  for (const [projectId, ids] of Object.entries(threadIdsByProject)) {
    setSourceMembers(meta, projectSource(projectId), ids, totals[projectId] ?? ids.length);
  }
}

function replaceList(
  meta: ThreadListMetaStore,
  source: ThreadSourceKey,
  ids: string[] | undefined,
  total: number | undefined,
): void {
  if (ids) setSourceMembers(meta, source, ids, total ?? ids.length);
}

/**
 * Replace the current session's thread rows and lists with `fields`.
 * `threadsById` replaces every row (rows not in it are removed); each list
 * field replaces that list. Fields left out are kept.
 */
export function seedThreadIndex(
  fields: ThreadIndexFields,
  layer: DataLayer = getDataLayer(),
): void {
  const data = getThreadsData(layer);
  if (fields.threadsById) replaceRows(data, fields.threadsById);
  if (fields.threadIdsByProject) {
    replaceProjectLists(data.meta, fields.threadIdsByProject, fields.threadTotalByProject);
  }
  replaceList(data.meta, 'scratch', fields.scratchThreadIds, fields.scratchThreadTotal);
  replaceList(data.meta, 'shared', fields.sharedThreadIds, fields.sharedThreadTotal);
}

/**
 * Seed the index fields of a store patch and return the rest, so a legacy
 * fixture keeps its shape: `useThreadStore.setState(withThreadIndex({ threadsById, selectedThreadId }))`.
 */
export function withThreadIndex<T extends object>(patch: T): Omit<T, IndexKey> {
  const fields: ThreadIndexFields = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if ((INDEX_KEYS as readonly string[]).includes(key))
      (fields as Record<string, unknown>)[key] = value;
    else rest[key] = value;
  }
  seedThreadIndex(fields);
  return rest as Omit<T, IndexKey>;
}

/**
 * For handler tests that drive a plain-object state: seed `fields` and expose
 * them on `target` as live getters over the data layer, so assertions such as
 * `state.threadsById.t1.status` read what the handlers wrote.
 */
export function attachThreadIndex<T extends object>(
  target: T,
  fields: ThreadIndexFields,
): T & ThreadIndexSnapshot {
  seedThreadIndex(fields);
  for (const key of INDEX_KEYS) {
    Object.defineProperty(target, key, {
      get: () => readThreadIndex()[key],
      enumerable: true,
      configurable: true,
    });
  }
  return target as T & ThreadIndexSnapshot;
}

/** Seed rows grouped by project (`{ projectId → Thread[] }`) as listed projects. */
export function seedProjectThreads(threadsByProject: Record<string, Thread[]>): void {
  const threadsById: Record<string, Thread> = {};
  const threadIdsByProject: Record<string, string[]> = {};
  for (const [projectId, threads] of Object.entries(threadsByProject)) {
    threadIdsByProject[projectId] = threads.map((t) => t.id);
    for (const thread of threads) threadsById[thread.id] = thread;
  }
  seedThreadIndex({ threadsById, threadIdsByProject });
}
