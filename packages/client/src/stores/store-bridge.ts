/**
 * Store bridge — breaks the bidirectional import cycle between
 * project-store and thread-store by providing late-bound accessors.
 *
 * Both stores register themselves here on creation. Cross-store
 * operations go through this module instead of importing each other.
 */

import type { StoreApi } from 'zustand';

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

/** Snapshot of `threadsByProject` for read-only branchKey computation. */
export function getThreadsByProject(): Record<string, any[]> {
  const store = _threadStoreRef.current;
  if (!store) return {};
  return store.getState().threadsByProject;
}

// ── Project → Thread operations ──────────────────────────────

/** Batch-update threadsByProject and threadTotalByProject in thread-store */
export function batchUpdateThreads(
  updates: Array<{ projectId: string; threads: any[] | null; total: number }>,
): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  const state = store.getState();
  const prev = state.threadsByProject;
  const prevTotals = state.threadTotalByProject;
  let changed = false;
  const next: Record<string, any[]> = { ...prev };
  const nextTotals: Record<string, number> = { ...prevTotals };
  for (const { projectId, threads, total } of updates) {
    if (threads && threads !== prev[projectId]) {
      next[projectId] = threads;
      nextTotals[projectId] = total;
      changed = true;
    }
  }
  if (changed) store.setState({ threadsByProject: next, threadTotalByProject: nextTotals });
}

/** Load threads for a project if not already loaded */
export function ensureThreadsLoaded(projectId: string): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  const state = store.getState();
  if (!state.threadsByProject[projectId]) {
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
