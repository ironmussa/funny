/**
 * Store bridge — breaks the bidirectional import cycle between
 * project-store and thread-store by providing late-bound accessors.
 *
 * Both stores register themselves here on creation. Cross-store
 * operations go through this module instead of importing each other.
 */

import type { StoreApi } from 'zustand';

import { isProjectListed, readThreadRow } from '@/data/threads/read';

// ── Lazy references (set once per store creation) ────────────

type LazyRef<T> = { current: StoreApi<T> | null };

const _projectStoreRef: LazyRef<any> = { current: null };
const _threadStoreRef: LazyRef<any> = { current: null };

/** Called by project-store during creation to register itself */
export function registerProjectStore(store: StoreApi<any>): void {
  _projectStoreRef.current = store;
}

/** Called by thread-store during creation to register itself */
export function registerThreadStore(store: StoreApi<any>): void {
  _threadStoreRef.current = store;
}

// ── Project → Git Status operations ──────────────────────────

/** Refetch git status for a project (fire-and-forget). */
export function fetchGitStatusForProject(projectId: string): void {
  // Loaded lazily, as before: the bridge stays out of the git request graph.
  void import('@/data/git-status/actions').then(({ fetchForProject }) =>
    fetchForProject(projectId),
  );
}

// ── Git Status → Thread operations ───────────────────────────

/**
 * Look up a Thread by id from the unified index. Returns null if not loaded.
 * Use this when non-React code needs to apply a `thread-variant` predicate
 * but only has the threadId in scope (React components should use
 * `useThreadById` from `lib/thread-selectors` instead).
 */
export function findThreadById(threadId: string): any | null {
  const fromRows = readThreadRow(threadId);
  if (fromRows) return fromRows;
  // activeThread is loaded with messages so it may exist before its row is
  // listed (race during selectThread). Return it so predicates still work.
  const active = _threadStoreRef.current?.getState().activeThread;
  if (active?.id === threadId) return active;
  return null;
}

// ── Project → Thread operations ──────────────────────────────

/** Load threads for a project if not already loaded */
export function ensureThreadsLoaded(projectId: string): void {
  const store = _threadStoreRef.current;
  if (!store) return;
  if (!isProjectListed(projectId)) {
    store.getState().loadThreadsForProject(projectId);
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
