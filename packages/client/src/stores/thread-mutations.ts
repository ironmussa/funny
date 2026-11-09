import type { ThreadState } from './thread-state';
import type { ThreadWithMessages } from './thread-types';

/**
 * Atomic mutation helpers for the loaded thread payload map
 * (`threadDataById`) and its `activeThread` mirror.
 *
 * Thread rows and list order are not stored here: they live in the data
 * layer's threads collection (`src/data/threads`).
 *
 * These helpers return a `Partial<ThreadState>` patch the caller hands to
 * `set()`, keeping references unchanged when nothing changed.
 */

// ── Public mutations: threadDataById ("thread gordo") ──────────────────
//
// `threadDataById` is the single source of truth for the loaded thread
// payload (messages, toolCalls, threadEvents, initInfo, …).
// Both the right pane (single thread) and the live-columns grid read and
// write through this map — so a single write path is enough for every
// surface that needs the thread.
//
// `activeThread` is kept as a derived mirror of
// `threadDataById[selectedThreadId]`. These helpers patch the map AND
// update the mirror in the same `set()` so the two never drift.

/**
 * Apply a functional patch to the entry in `threadDataById`. The updater
 * receives the current ThreadWithMessages; returning the SAME reference
 * (or `null`) signals "no change" and `set()` becomes a no-op.
 *
 * If the patched thread is currently selected, the new value is mirrored
 * onto `activeThread` in the same patch — so legacy consumers reading
 * `s.activeThread` stay coherent without a second write path.
 *
 * Returns `{}` when the thread is not loaded into the map (caller should
 * buffer the event or trigger a refresh). Callers should NOT use this to
 * insert new entries — use `setThreadData` instead.
 */
export function applyThreadDataPatch(
  state: ThreadState,
  threadId: string,
  updater: (thread: ThreadWithMessages) => ThreadWithMessages | null,
): Partial<ThreadState> {
  const cur = state.threadDataById[threadId];
  if (!cur) return {};
  const next = updater(cur);
  if (next === null || next === cur) return {};
  const patch: Partial<ThreadState> = {
    threadDataById: { ...state.threadDataById, [threadId]: next },
  };
  if (state.selectedThreadId === threadId) {
    patch.activeThread = next;
  }
  return patch;
}

/**
 * Insert or replace a thread's payload in `threadDataById`. Used by
 * `selectThread` (hydration) and `registerLiveThread` (initial fetch).
 * Mirrors onto `activeThread` if the thread is currently selected.
 */
export function setThreadData(
  state: ThreadState,
  threadId: string,
  thread: ThreadWithMessages,
): Partial<ThreadState> {
  const patch: Partial<ThreadState> = {
    threadDataById: { ...state.threadDataById, [threadId]: thread },
  };
  if (state.selectedThreadId === threadId) {
    patch.activeThread = thread;
  }
  return patch;
}

/**
 * Drop a thread's payload from `threadDataById`. Used when the refcount
 * drops to 0 and the thread is no longer selected. Clears `activeThread`
 * iff the dropped thread was the active one (defensive — should not
 * normally happen, since selected threads are anchored).
 */
export function clearThreadData(state: ThreadState, threadId: string): Partial<ThreadState> {
  if (!(threadId in state.threadDataById)) return {};
  const { [threadId]: _, ...rest } = state.threadDataById;
  const patch: Partial<ThreadState> = { threadDataById: rest };
  if (state.selectedThreadId === threadId) {
    patch.activeThread = null;
  }
  return patch;
}
