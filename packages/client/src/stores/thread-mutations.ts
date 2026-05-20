import type { Thread } from '@funny/shared';

import type { ThreadState } from './thread-store';

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
  const prev = threadsById[thread.id];
  if (prev === thread) return threadsById;
  return { ...threadsById, [thread.id]: thread };
}

function withThreadsUpserted(
  threadsById: Record<string, Thread>,
  threads: Thread[],
): Record<string, Thread> {
  if (threads.length === 0) return threadsById;
  const next = { ...threadsById };
  let changed = false;
  for (const t of threads) {
    if (next[t.id] !== t) {
      next[t.id] = t;
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
  return {
    threadsById: withThreadsUpserted(state.threadsById, threads),
    threadIdsByProject: { ...state.threadIdsByProject, [projectId]: newIds },
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

// ── Lookup helpers (non-mutating) ────────────────────────────────────────

/** Find which projectId a thread belongs to. Returns null for scratch / unknown. */
export function findProjectForThread(state: ThreadState, threadId: string): string | null {
  for (const pid in state.threadIdsByProject) {
    if (state.threadIdsByProject[pid].includes(threadId)) return pid;
  }
  return null;
}
