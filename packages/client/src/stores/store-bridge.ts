/**
 * Store bridge — breaks the bidirectional import cycle between
 * project-store and thread-store by providing late-bound accessors.
 *
 * Both stores register themselves here on creation. Cross-store
 * operations go through this module instead of importing each other.
 */

import type { StoreApi } from 'zustand';

import { isScratch } from '@/lib/thread-variant';

// ── Lazy references (set once per store creation) ────────────

type LazyRef<T> = { current: StoreApi<T> | null };

const _projectStoreRef: LazyRef<any> = { current: null };
const _threadStoreRef: LazyRef<any> = { current: null };
const _gitStatusStoreRef: LazyRef<any> = { current: null };

/** Called by project-store during creation to register itself */
export function registerProjectStore(store: StoreApi<any>): void {
  _projectStoreRef.current = store;
}

/** Called by thread-store during creation to register itself */
export function registerThreadStore(store: StoreApi<any>): void {
  _threadStoreRef.current = store;
}

/** Called by git-status-store during creation to register itself */
export function registerGitStatusStore(store: StoreApi<any>): void {
  _gitStatusStoreRef.current = store;
}

// ── Project → Git Status operations ──────────────────────────

/** Refetch git status for a project (fire-and-forget). */
export function fetchGitStatusForProject(projectId: string): void {
  const store = _gitStatusStoreRef.current;
  if (!store) return;
  store.getState().fetchForProject(projectId);
}

// ── Git Status → Thread operations ───────────────────────────

/**
 * Snapshot of `{ projectId → Thread[] }` derived from the unified index.
 * Used by non-React code (git-status-store branchKey lookup, etc.) that
 * needs to iterate threads by project. Components should use
 * `useThreadsByProject` from `lib/thread-selectors` instead.
 */
export function getThreadsByProject(): Record<string, any[]> {
  const store = _threadStoreRef.current;
  if (!store) return {};
  const state = store.getState();
  if (!state.threadIdsByProject) return {};
  const result: Record<string, any[]> = {};
  for (const pid in state.threadIdsByProject) {
    const ids = state.threadIdsByProject[pid];
    if (!ids) continue;
    result[pid] = ids.map((id: string) => state.threadsById[id]).filter(Boolean);
  }
  return result;
}

/**
 * Look up a Thread by id from the unified index. Returns null if not loaded.
 * Use this when non-React code needs to apply a `thread-variant` predicate
 * but only has the threadId in scope (React components should use
 * `useThreadById` from `lib/thread-selectors` instead).
 */
export function findThreadById(threadId: string): any | null {
  const store = _threadStoreRef.current;
  if (!store) return null;
  const state = store.getState();
  const fromIndex = state.threadsById[threadId];
  if (fromIndex) return fromIndex;
  // activeThread is loaded with messages so it may exist even when not in
  // threadsById (race during selectThread). Return it so predicates still work.
  if (state.activeThread?.id === threadId) return state.activeThread;
  return null;
}

/**
 * Thin id-based wrapper around `isScratch`. Prefer passing the Thread
 * object directly to `isScratch` when you already have it; use this when
 * the call site only has the threadId.
 */
export function isScratchThread(threadId: string): boolean {
  return isScratch(findThreadById(threadId));
}

// ── Project → Thread operations ──────────────────────────────

/**
 * Batch-update multiple projects' thread lists in a single `setState` so the
 * sidebar renders once instead of N times. Threads land in `threadsById` and
 * their ordered IDs in `threadIdsByProject` — same shape every other write
 * uses, so the rest of the store stays consistent.
 */
export function batchUpdateThreads(
  updates: Array<{ projectId: string; threads: any[] | null; total: number }>,
): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  const state = store.getState();
  let changed = false;
  const nextById = { ...state.threadsById };
  const nextIdsByProject = { ...state.threadIdsByProject };
  const nextTotals = { ...state.threadTotalByProject };
  for (const { projectId, threads, total } of updates) {
    if (!threads) continue;
    const newIds = threads.map((t) => t.id);
    const prevIds = state.threadIdsByProject[projectId];
    // Skip if the ID array is identical (same order, same length) — the
    // server returned the same list, no need to thrash references.
    const idsUnchanged =
      prevIds &&
      prevIds.length === newIds.length &&
      prevIds.every((id: string, i: number) => id === newIds[i]);
    if (idsUnchanged && state.threadTotalByProject[projectId] === total) continue;
    for (const t of threads) nextById[t.id] = t;
    nextIdsByProject[projectId] = newIds;
    nextTotals[projectId] = total;
    changed = true;
  }
  if (changed) {
    store.setState({
      threadsById: nextById,
      threadIdsByProject: nextIdsByProject,
      threadTotalByProject: nextTotals,
    });
  }
}

/** Load threads for a project if not already loaded */
export function ensureThreadsLoaded(projectId: string): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  const state = store.getState();
  if (!state.threadIdsByProject[projectId]) {
    state.loadThreadsForProject(projectId);
  }
}

/** Clear threads for a deleted project */
export function clearProjectThreads(projectId: string): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  store.getState().clearProjectThreads(projectId);
}

// ── Thread → Project operations ──────────────────────────────

/** Expand a project in the sidebar (used when navigating to a thread) */
export function expandProject(projectId: string): void {
  const store = _projectStoreRef.current;
  if (!store) return;
  const state = store.getState();
  if (!state.expandedProjects.has(projectId)) {
    const next = new Set(state.expandedProjects);
    next.add(projectId);
    store.setState({ expandedProjects: next });
  }
}

/** Set the selected project ID */
export function selectProject(projectId: string): void {
  const store = _projectStoreRef.current;
  if (!store) return;
  store.setState({ selectedProjectId: projectId });
}

/** Find a project by ID and return its path */
export function getProjectPath(projectId: string): string | undefined {
  const store = _projectStoreRef.current;
  if (!store) return undefined;
  const project = store.getState().projects.find((p: any) => p.id === projectId);
  return project?.path;
}
