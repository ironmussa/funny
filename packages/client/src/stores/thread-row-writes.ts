import type { Thread } from '@funny/shared';

import { getThreadsData } from '@/data/threads/store';

/**
 * Patch a thread row as a synced write in the threads collection, the only
 * store of thread rows (realtime events: status, snippet, stage, …).
 *
 * The updater receives the confirmed row — never an optimistic overlay, so a
 * realtime patch can't bake an unconfirmed user write into server state — and
 * returning the same reference means "no change". Every view, the detail view
 * included (`thread-view.ts`), reads the row from the collection, so there is
 * nothing to copy anywhere else. Rows the collection does not hold are left
 * alone (realtime events for unlisted threads trigger a list refresh instead;
 * see thread-ws-handlers). Returns whether the row is held.
 */
export function patchThreadRow(threadId: string, updater: (thread: Thread) => Thread): boolean {
  const data = getThreadsData();
  if (!data.getSynced(threadId)) return false;
  data.patchSynced(threadId, updater);
  return true;
}
