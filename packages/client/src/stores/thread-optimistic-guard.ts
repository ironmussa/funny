import type { Thread, ThreadStage } from '@funny/shared';

/**
 * Optimistic Kanban writes (archive / unarchive / stage move) that must not be
 * reverted by a list GET whose request started *before* the write committed.
 *
 * Symptom without this guard: drag a card to "Archived" (or another column);
 * the store updates optimistically; a concurrent `loadThreadsForProject` /
 * `refreshAllLoadedThreads` resolves with the pre-write snapshot and upserts
 * the thread with its old `stage` / `archived`, so the card visibly "bounces"
 * back to its previous column until a manual refresh re-fetches the now-
 * committed state.
 *
 * We hold the optimistic `stage` / `archived` for a short grace window and
 * re-apply it onto any server page that arrives meanwhile. Once the server
 * snapshot already reflects the write (or the window lapses) the guard clears,
 * so a genuine change from another tab still converges.
 */
type Guarded = { stage?: ThreadStage; archived?: boolean; until: number };

const _guards = new Map<string, Guarded>();

/** Grace window: long enough to cover an in-flight list GET, short enough that
 *  a real cross-tab change converges quickly. */
const GRACE_MS = 5000;

/** Record (or extend) an optimistic board write for a thread. */
export function guardOptimisticBoardWrite(
  threadId: string,
  fields: { stage?: ThreadStage; archived?: boolean },
): void {
  const prev = _guards.get(threadId);
  _guards.set(threadId, { ...prev, ...fields, until: Date.now() + GRACE_MS });
}

/** Drop a thread's guard (e.g. on delete). */
export function clearOptimisticBoardWrite(threadId: string): void {
  _guards.delete(threadId);
}

/** Test-only: wipe all guards. */
export function _resetOptimisticBoardWrites(): void {
  _guards.clear();
}

/**
 * Reconcile a server-provided Thread against any active optimistic board
 * write, keeping the optimistic `stage` / `archived` until the grace window
 * lapses. Returns the SAME reference when nothing is guarded so the hot
 * list-merge path allocates nothing in the common case.
 */
export function reconcileBoardWrite(thread: Thread): Thread {
  const g = _guards.get(thread.id);
  if (!g) return thread;
  if (Date.now() > g.until) {
    _guards.delete(thread.id);
    return thread;
  }
  const stageMatches = g.stage === undefined || g.stage === thread.stage;
  const archivedMatches = g.archived === undefined || !!g.archived === !!thread.archived;
  // Server already reflects the optimistic write — clear the guard and let the
  // server copy flow through unchanged (no needless re-render).
  if (stageMatches && archivedMatches) {
    _guards.delete(thread.id);
    return thread;
  }
  return {
    ...thread,
    ...(g.stage !== undefined ? { stage: g.stage } : {}),
    ...(g.archived !== undefined ? { archived: g.archived } : {}),
  };
}
