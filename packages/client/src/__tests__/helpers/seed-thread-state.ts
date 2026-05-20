import type { Thread } from '@funny/shared';

/**
 * Test helper: convert the legacy `{ projectId → Thread[] }` shape into a
 * partial state slice for the unified thread store. Lets tests express
 * fixtures naturally without hand-building `threadsById` + ID arrays.
 */
export function seedThreads(threadsByProject: Record<string, Thread[]>) {
  const threadsById: Record<string, Thread> = {};
  const threadIdsByProject: Record<string, string[]> = {};
  for (const pid in threadsByProject) {
    const threads = threadsByProject[pid];
    threadIdsByProject[pid] = threads.map((t) => t.id);
    for (const t of threads) threadsById[t.id] = t;
  }
  return { threadsById, threadIdsByProject };
}

/** Project bucket as a plain array — for tests that previously read
 *  `state.threadsByProject[pid]`. */
export function readProjectThreads<
  T extends { threadsById: Record<string, Thread>; threadIdsByProject: Record<string, string[]> },
>(state: T, projectId: string): Thread[] {
  const ids = state.threadIdsByProject[projectId];
  if (!ids) return [];
  return ids.map((id) => state.threadsById[id]).filter(Boolean);
}
