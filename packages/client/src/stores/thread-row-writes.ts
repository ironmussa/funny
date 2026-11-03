import type { Thread } from '@funny/shared';

import { getThreadsData } from '@/data/threads/store';

import type { ThreadState } from './thread-state';

/**
 * Patch a thread row as a synced write in the threads collection, the only
 * store of thread rows.
 *
 * Drop-in for the former `mutations.patchThread`: the updater receives the
 * confirmed row — never an optimistic overlay, so a realtime patch can't bake
 * an unconfirmed user write into server state — and returning the same
 * reference means "no change". The returned partial only mirrors changed
 * fields onto `activeThread` (design D8; removed with the row copy in phase 5).
 * Rows the collection does not hold are left alone (realtime events for
 * unlisted threads trigger a list refresh instead; see thread-ws-handlers).
 */
export function patchThreadRow(
  state: ThreadState,
  threadId: string,
  updater: (thread: Thread) => Thread,
): Partial<ThreadState> {
  const data = getThreadsData();
  const prev = data.getSynced(threadId);
  if (!prev) return {};
  const next = data.patchSynced(threadId, updater);
  if (!next) return {};
  if (state.activeThread?.id !== threadId) return {};
  const changedFields = Object.fromEntries(
    Object.entries(next).filter(([key, value]) => !Object.is(prev[key as keyof Thread], value)),
  ) as Partial<Thread>;
  return { activeThread: { ...state.activeThread, ...changedFields } };
}
