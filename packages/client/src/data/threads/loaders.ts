import type { Thread } from '@funny/shared';

import { api } from '@/lib/api';
import { metric } from '@/lib/telemetry';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import {
  clearSource,
  projectSource,
  removeFromSources,
  setSourceMembers,
  type ThreadSourceKey,
} from './list-meta';
import { getThreadsData, type ThreadsData } from './store';

/**
 * Thread list loaders. Each one stamps its request with a fencing sequence,
 * fetches through the layer's QueryClient (concurrent calls for the same
 * list share one request), and applies the page to the collection and the
 * list metadata exactly once, inside the query function.
 *
 * Thread lists are always refetched when asked (`staleTime: 0`), as before
 * the data layer; query-core only de-duplicates calls that are in flight.
 */

const PROJECT_PAGE_SIZE = 50;
const SCRATCH_PAGE_SIZE = 100;

interface Page {
  threads: Thread[];
  total: number;
}

function uniqueIds(threads: readonly Thread[]): string[] {
  return [...new Set(threads.map((t) => t.id))];
}

async function fetchOnce<T>(layer: DataLayer, queryKey: unknown[], run: () => Promise<T>) {
  try {
    return await layer.queryClient.fetchQuery({ queryKey, queryFn: run, staleTime: 0 });
  } catch (error) {
    metric('data.threads.load_failed', 1, { attributes: { list: String(queryKey[1]) } });
    throw error;
  }
}

/**
 * Replace a project's first page. Archived rows already in the list survive
 * a reload that omits them (a non-archived reload, or a refresh right after
 * a card was archived), so the Kanban "Archived" column keeps its cards.
 * Consumers that hide archived threads filter them out.
 */
function applyProjectFirstPage(data: ThreadsData, projectId: string, page: Page, seq: number) {
  data.upsertFromServer(page.threads, seq);
  const source = projectSource(projectId);
  const newIds = uniqueIds(page.threads);
  const incoming = new Set(newIds);
  const preserved = (data.meta.getState().members[source] ?? []).filter(
    (id) => !incoming.has(id) && data.collection.get(id)?.archived,
  );
  setSourceMembers(
    data.meta,
    source,
    preserved.length ? [...newIds, ...preserved] : newIds,
    page.total,
  );
}

export async function loadProjectThreads(
  projectId: string,
  includeArchived = false,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  // An empty projectId would reach listThreads(undefined) and return every
  // thread of the user. Scratch threads load through loadScratchThreads.
  if (!projectId) return;
  const data = getThreadsData(layer);
  await fetchOnce(layer, ['threads', 'project', projectId, { includeArchived }], async () => {
    const seq = data.beginRequest();
    const page = await unwrapResult(api.listThreads(projectId, includeArchived, PROJECT_PAGE_SIZE));
    applyProjectFirstPage(data, projectId, page, seq);
    return null;
  }).catch(() => undefined);
}

/** Append the next page of a project's list. Offset = rows already listed. */
export async function loadMoreProjectThreads(
  projectId: string,
  includeArchived = false,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  if (!projectId) return;
  const data = getThreadsData(layer);
  const source = projectSource(projectId);
  const offset = data.meta.getState().members[source]?.length ?? 0;
  await fetchOnce(
    layer,
    ['threads', 'project-page', projectId, { includeArchived, offset }],
    async () => {
      const seq = data.beginRequest();
      const page = await unwrapResult(
        api.listThreads(projectId, includeArchived, PROJECT_PAGE_SIZE, offset),
      );
      data.upsertFromServer(page.threads, seq);
      const existing = data.meta.getState().members[source] ?? [];
      const known = new Set(existing);
      const appended = uniqueIds(page.threads).filter((id) => !known.has(id));
      setSourceMembers(data.meta, source, [...existing, ...appended], page.total);
      return null;
    },
  ).catch(() => undefined);
}

async function loadWholeSource(
  layer: DataLayer,
  source: ThreadSourceKey,
  request: () => Promise<{ threads: Thread[]; total?: number }>,
): Promise<void> {
  const data = getThreadsData(layer);
  await fetchOnce(layer, ['threads', source], async () => {
    const seq = data.beginRequest();
    const page = await request();
    data.upsertFromServer(page.threads, seq);
    setSourceMembers(data.meta, source, uniqueIds(page.threads), page.total ?? page.threads.length);
    return null;
  }).catch(() => undefined);
}

export function loadScratchThreads(layer: DataLayer = getDataLayer()): Promise<void> {
  return loadWholeSource(layer, 'scratch', () =>
    unwrapResult(api.listScratchThreads(SCRATCH_PAGE_SIZE)),
  );
}

export function loadSharedThreads(layer: DataLayer = getDataLayer()): Promise<void> {
  return loadWholeSource(layer, 'shared', () => unwrapResult(api.listSharedWithMe()));
}

/** Put a freshly created scratch thread at the front of the scratch list. */
export function addScratchThread(thread: Thread, layer: DataLayer = getDataLayer()): void {
  const data = getThreadsData(layer);
  const { members, totals } = data.meta.getState();
  const ids = members.scratch ?? [];
  // De-dupe against WS-vs-API ordering races.
  if (ids.includes(thread.id)) return;
  data.upsertFresh([thread]);
  setSourceMembers(data.meta, 'scratch', [thread.id, ...ids], (totals.scratch ?? 0) + 1);
}

/** Stamp a detail request (e.g. `getThread`) that starts now, for write fencing. */
export function beginThreadRequest(layer: DataLayer = getDataLayer()): number {
  return getThreadsData(layer).beginRequest();
}

/**
 * Merge row fields from a thread detail response stamped by
 * `beginThreadRequest()`. Only updates a row that is already listed: a detail
 * response alone never adds a thread to a list.
 */
export function applyThreadDetail(
  threadId: string,
  fields: Partial<Thread>,
  startedSeq: number,
  layer: DataLayer = getDataLayer(),
): void {
  const data = getThreadsData(layer);
  const prev = data.getSynced(threadId);
  if (!prev) return;
  data.upsertFromServer([{ ...prev, ...fields }], startedSeq);
}

/** Detail-response fields that belong to the loaded conversation, not to the thread row. */
const DETAIL_PAYLOAD_KEYS = new Set([
  'messages',
  'hasMore',
  'hasMoreAfter',
  'total',
  'windowStart',
  'initInfo',
  'lastUserMessage',
  'leadingUserMessage',
  'queuedCount',
  'queuedNextMessage',
  'waitingReason',
  'pendingPermission',
  'pendingPermissionRequest',
  'permissionApprovalCapability',
  'permissionRecoveryReason',
]);

/** The thread row part of a detail response (`api.getThread`). */
function threadRowOfDetail(detail: Thread): Thread {
  return Object.fromEntries(
    Object.entries(detail).filter(([key]) => !DETAIL_PAYLOAD_KEYS.has(key)),
  ) as unknown as Thread;
}

/**
 * Make sure an opened thread has a row: the detail view reads row fields
 * (status, title, …) only from the collection. A thread opened by URL can be
 * outside every loaded list; its row is added without joining a list.
 *
 * A held row wins over the detail, which may come from a prefetch cache and
 * be older than the row's list or realtime updates; the detail only fills in
 * fields the row lacks.
 */
export function adoptThreadDetail(detail: Thread, layer: DataLayer = getDataLayer()): void {
  const data = getThreadsData(layer);
  const row = threadRowOfDetail(detail);
  if (!data.getSynced(row.id)) {
    data.upsertFresh([row]);
    return;
  }
  data.patchSynced(row.id, (prev) => {
    const missing = Object.entries(row).filter(
      ([key, value]) => value !== undefined && prev[key as keyof Thread] === undefined,
    );
    return missing.length > 0 ? { ...prev, ...Object.fromEntries(missing) } : prev;
  });
}

/** Drop a project's list and its rows (project deleted or closed). */
export function dropProjectThreads(projectId: string, layer: DataLayer = getDataLayer()): void {
  const data = getThreadsData(layer);
  const source = projectSource(projectId);
  const ids = data.meta.getState().members[source];
  if (!ids) return;
  data.removeRows(ids);
  clearSource(data.meta, source);
}

/** Remove a thread everywhere without calling the server (deleted elsewhere, share revoked). */
export function removeThreadLocally(threadId: string, layer: DataLayer = getDataLayer()): void {
  const data = getThreadsData(layer);
  data.removeRows([threadId]);
  removeFromSources(data.meta, threadId);
}
