import type { Thread } from '@funny/shared';

import { reconcileBoardWrite } from './thread-optimistic-guard';
import type { ThreadState } from './thread-state';
import type { ThreadWithMessages } from './thread-types';

/**
 * Atomic mutation helpers for `threadsById` + the order-preserving ID arrays.
 *
 * The store keeps three concerns separate:
 *   - `threadsById`         — the only place a Thread row lives.
 *   - `threadIdsByProject`  — per-project order.
 *   - `scratchThreadIds`    — scratch order (most recent first).
 *
 * These helpers return a `Partial<ThreadState>` patch the caller hands to
 * `set()`. They're built so that arrays / objects that didn't actually
 * change keep the same reference — preserving render stability across
 * `useShallow` selectors.
 */

// ── Internal: build a new threadsById with one entry replaced/added ─────

function withThreadUpserted(
  threadsById: Record<string, Thread>,
  thread: Thread,
): Record<string, Thread> {
  // Re-apply any pending optimistic board write so a stale server snapshot
  // can't revert a just-archived / just-moved card (see thread-optimistic-guard).
  const reconciled = reconcileBoardWrite(thread);
  const prev = threadsById[reconciled.id];
  if (prev === reconciled) return threadsById;
  return { ...threadsById, [reconciled.id]: reconciled };
}

function withThreadsUpserted(
  threadsById: Record<string, Thread>,
  threads: Thread[],
): Record<string, Thread> {
  if (threads.length === 0) return threadsById;
  const next = { ...threadsById };
  let changed = false;
  for (const t of threads) {
    // Re-apply any pending optimistic board write before merging the server row.
    const reconciled = reconcileBoardWrite(t);
    if (next[reconciled.id] !== reconciled) {
      next[reconciled.id] = reconciled;
      changed = true;
    }
  }
  return changed ? next : threadsById;
}

function withThreadRemoved(
  threadsById: Record<string, Thread>,
  threadId: string,
): Record<string, Thread> {
  if (!(threadId in threadsById)) return threadsById;
  const { [threadId]: _, ...rest } = threadsById;
  return rest;
}

// ── Public mutations: project-thread buckets ────────────────────────────

/**
 * Replace a project's thread list (server response order). Used by the
 * initial `loadThreadsForProject` fetch.
 */
export function replaceProjectThreads(
  state: ThreadState,
  projectId: string,
  threads: Thread[],
  total: number,
): Partial<ThreadState> {
  const newIds = threads.map((t) => t.id);
  const incoming = new Set(newIds);
  // Preserve archived threads already resident in this bucket that the
  // incoming page omits (a non-archived reload, or a refresh right after a
  // card was archived so the server no longer returns it). Every consumer that
  // must hide archived threads — the sidebar and the list view — filters them
  // out defensively, so keeping them resident is safe; it stops the Kanban
  // "Archived" column from losing cards on every refresh.
  const preservedArchivedIds = (state.threadIdsByProject[projectId] ?? []).filter(
    (id) => !incoming.has(id) && state.threadsById[id]?.archived,
  );
  return {
    threadsById: withThreadsUpserted(state.threadsById, threads),
    threadIdsByProject: {
      ...state.threadIdsByProject,
      [projectId]: preservedArchivedIds.length ? [...newIds, ...preservedArchivedIds] : newIds,
    },
    threadTotalByProject: { ...state.threadTotalByProject, [projectId]: total },
  };
}

/**
 * Append more threads to a project's list (pagination). Skips duplicates so
 * a double-load doesn't render the same thread twice.
 */
export function appendProjectThreads(
  state: ThreadState,
  projectId: string,
  threads: Thread[],
  total: number,
): Partial<ThreadState> {
  if (threads.length === 0) {
    return { threadTotalByProject: { ...state.threadTotalByProject, [projectId]: total } };
  }
  const existing = state.threadIdsByProject[projectId] ?? [];
  const existingSet = new Set(existing);
  const appended: string[] = [];
  for (const t of threads) {
    if (!existingSet.has(t.id)) appended.push(t.id);
  }
  return {
    threadsById: withThreadsUpserted(state.threadsById, threads),
    threadIdsByProject: {
      ...state.threadIdsByProject,
      [projectId]: [...existing, ...appended],
    },
    threadTotalByProject: { ...state.threadTotalByProject, [projectId]: total },
  };
}

/** Drop all entries for a project (used after delete). */
export function clearProjectBucket(state: ThreadState, projectId: string): Partial<ThreadState> {
  const ids = state.threadIdsByProject[projectId];
  if (!ids) return {};
  let nextById = state.threadsById;
  for (const id of ids) {
    nextById = withThreadRemoved(nextById, id);
  }
  const { [projectId]: _, ...restIds } = state.threadIdsByProject;
  const { [projectId]: __, ...restTotals } = state.threadTotalByProject;
  return {
    threadsById: nextById,
    threadIdsByProject: restIds,
    threadTotalByProject: restTotals,
  };
}

// ── Public mutations: scratch bucket ─────────────────────────────────────

export function replaceScratchThreads(
  state: ThreadState,
  threads: Thread[],
  total?: number,
): Partial<ThreadState> {
  return {
    threadsById: withThreadsUpserted(state.threadsById, threads),
    scratchThreadIds: threads.map((t) => t.id),
    scratchThreadTotal: total ?? threads.length,
  };
}

/** Add a freshly created scratch thread to the front of the list. */
export function prependScratchThread(state: ThreadState, thread: Thread): Partial<ThreadState> {
  // De-dupe against WS-vs-API ordering races.
  if (state.scratchThreadIds.includes(thread.id)) return {};
  return {
    threadsById: withThreadUpserted(state.threadsById, thread),
    scratchThreadIds: [thread.id, ...state.scratchThreadIds],
    scratchThreadTotal: state.scratchThreadTotal + 1,
  };
}

// ── Public mutations: cross-bucket ──────────────────────────────────────

/**
 * Remove a thread wherever it lives (project bucket or scratch). Knows
 * about both without the caller needing to.
 */
export function removeThread(state: ThreadState, threadId: string): Partial<ThreadState> {
  const patch: Partial<ThreadState> = {
    threadsById: withThreadRemoved(state.threadsById, threadId),
  };
  if (state.scratchThreadIds.includes(threadId)) {
    patch.scratchThreadIds = state.scratchThreadIds.filter((id) => id !== threadId);
    patch.scratchThreadTotal = Math.max(0, state.scratchThreadTotal - 1);
  }
  for (const pid in state.threadIdsByProject) {
    const ids = state.threadIdsByProject[pid];
    if (ids.includes(threadId)) {
      const next = ids.filter((id) => id !== threadId);
      patch.threadIdsByProject = { ...state.threadIdsByProject, [pid]: next };
      const prevTotal = state.threadTotalByProject[pid] ?? next.length;
      patch.threadTotalByProject = {
        ...state.threadTotalByProject,
        [pid]: Math.max(0, prevTotal - 1),
      };
      break;
    }
  }
  return patch;
}

/**
 * Apply an in-place update to a single thread. The updater receives the
 * current Thread; returning the SAME reference signals "no change" and
 * `set()` becomes a no-op (no React re-render).
 *
 * When the patched thread is also the currently-active one (right pane),
 * the mirrored fields are propagated onto `activeThread` so the chat view
 * stays in sync without a separate write path. Fields the updater touches
 * are shallowly merged onto activeThread.
 *
 * Use this for status / title / pinned / stage / lastAssistantMessage —
 * any field that mutates without changing which bucket the thread lives in.
 */
export function patchThread(
  state: ThreadState,
  threadId: string,
  updater: (thread: Thread) => Thread,
): Partial<ThreadState> {
  const existing = state.threadsById[threadId];
  if (!existing) return {};
  const next = updater(existing);
  if (next === existing) return {};
  const patch: Partial<ThreadState> = {
    threadsById: { ...state.threadsById, [threadId]: next },
  };
  if (state.activeThread?.id === threadId) {
    patch.activeThread = { ...state.activeThread, ...next };
  }
  return patch;
}

// ── Public mutations: threadDataById ("thread gordo") ──────────────────
//
// `threadDataById` is the single source of truth for the loaded thread
// payload (messages, toolCalls, threadEvents, initInfo, contextUsage, …).
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

// ── Lookup helpers (non-mutating) ────────────────────────────────────────

/** Find which projectId a thread belongs to. Returns null for scratch / unknown. */
export function findProjectForThread(state: ThreadState, threadId: string): string | null {
  for (const pid in state.threadIdsByProject) {
    if (state.threadIdsByProject[pid].includes(threadId)) return pid;
  }
  return null;
}
