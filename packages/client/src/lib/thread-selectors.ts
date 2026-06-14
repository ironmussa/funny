import type { Thread } from '@funny/shared';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useThreadStore, type ThreadState } from '@/stores/thread-store';

/**
 * Read-side API for the unified thread store. Threads are stored once in
 * `threadsById` with ID arrays providing order per bucket; these selectors
 * project that shape into the per-bucket arrays components actually consume.
 *
 * ## Render stability
 *
 * Selectors that derive arrays / records hold a tiny module-level memo
 * keyed by the input references (`threadsById` + the relevant ID array).
 * As long as those inputs don't change, the derived result keeps the SAME
 * reference — so React `memo` and `useShallow` comparisons return early
 * and components don't repaint. WS handlers update `threadsById` only when
 * a thread row actually changed (`mutations.patchThread` no-ops on
 * identical reference), which makes the memo a real cache rather than a
 * thundering recompute.
 *
 * Without this caching, `useThreadsByProject` returns a new object every
 * call and infinite-loops `useSyncExternalStore` via "getSnapshot should
 * be cached" — Zustand's `useShallow` is shallow, not deep, so per-project
 * arrays still need stable references.
 */

const EMPTY_THREADS: Thread[] = [];
const EMPTY_THREADS_BY_PROJECT: Record<string, Thread[]> = {};

// ── Memo: per-project Thread[] ───────────────────────────────
//
// Cache keyed by the ID array reference (a stable reference unless the
// bucket is replaced via load / append). On a hit we re-validate that
// every cached Thread still points at the current `threadsById` entry —
// when a single thread row was patched the rest stay reference-equal,
// so the cached array is invalidated only for the affected project.

const _projectArrayCache = new WeakMap<string[], Thread[]>();

function deriveProjectArray(
  threadsById: Record<string, Thread>,
  ids: string[] | undefined,
): Thread[] {
  if (!ids || ids.length === 0) return EMPTY_THREADS;
  const cached = _projectArrayCache.get(ids);
  if (cached && cached.length === ids.length) {
    let allSame = true;
    for (let i = 0; i < ids.length; i++) {
      if (cached[i] !== threadsById[ids[i]]) {
        allSame = false;
        break;
      }
    }
    if (allSame) return cached;
  }
  const result: Thread[] = [];
  for (const id of ids) {
    const t = threadsById[id];
    if (t) result.push(t);
  }
  _projectArrayCache.set(ids, result);
  return result;
}

// ── Memo: full { projectId → Thread[] } ──────────────────────
//
// The Record itself is rebuilt each call, but per-project arrays come
// from `deriveProjectArray` (stable refs for unchanged projects). So
// `useShallow` finds shallow-equal Records when nothing changed and
// skips the re-render.

function deriveThreadsByProject(
  threadsById: Record<string, Thread>,
  threadIdsByProject: Record<string, string[]>,
): Record<string, Thread[]> {
  const pids = Object.keys(threadIdsByProject);
  if (pids.length === 0) return EMPTY_THREADS_BY_PROJECT;
  const result: Record<string, Thread[]> = {};
  for (const pid of pids) {
    result[pid] = deriveProjectArray(threadsById, threadIdsByProject[pid]);
  }
  return result;
}

// ── Pure selectors ────────────────────────────────────────────

/** Look up a single Thread by id. Returns undefined if not loaded. */
export function selectThreadById(state: ThreadState, threadId: string): Thread | undefined {
  return state.threadsById[threadId];
}

/** Ordered Thread array for a project (server-response order). */
export function selectThreadsForProject(state: ThreadState, projectId: string): Thread[] {
  return deriveProjectArray(state.threadsById, state.threadIdsByProject[projectId]);
}

/** Ordered scratch-thread array (most recent first). */
export function selectScratchThreads(state: ThreadState): Thread[] {
  return deriveProjectArray(state.threadsById, state.scratchThreadIds);
}

/** Ordered "shared with me" thread array. */
export function selectSharedThreads(state: ThreadState): Thread[] {
  return deriveProjectArray(state.threadsById, state.sharedThreadIds);
}

/**
 * Full `{ projectId → Thread[] }` mapping. Use this only when truly iterating
 * across all projects (Activity feed, Kanban, AllThreads); prefer
 * `selectThreadsForProject` for project-scoped views.
 */
export function selectThreadsByProject(state: ThreadState): Record<string, Thread[]> {
  return deriveThreadsByProject(state.threadsById, state.threadIdsByProject);
}

// ── React hooks ───────────────────────────────────────────────

/** Reactive lookup for a single thread. */
export function useThreadById(threadId: string | null | undefined): Thread | undefined {
  return useThreadStore(
    useCallback(
      (s: ThreadState) => (threadId ? selectThreadById(s, threadId) : undefined),
      [threadId],
    ),
  );
}

/**
 * Reactive ordered Thread array for a project. Stable reference unless this
 * project's ID list or one of its threads actually changes.
 */
export function useThreadsForProject(projectId: string): Thread[] {
  return useThreadStore(
    useCallback((s: ThreadState) => selectThreadsForProject(s, projectId), [projectId]),
  );
}

/** Reactive scratch list. Stable reference unless scratch contents change. */
export function useScratchThreads(): Thread[] {
  return useThreadStore(selectScratchThreads);
}

/** Reactive "shared with me" list. Stable unless the shared bucket changes. */
export function useSharedThreads(): Thread[] {
  return useThreadStore(selectSharedThreads);
}

/**
 * Reactive `{ projectId → Thread[] }` mapping. Stable across renders thanks
 * to the module-level memo — only re-renders subscribers when a project's
 * thread list or contents actually change. Prefer `useThreadsForProject`
 * when you only need one project's slice.
 */
export function useThreadsByProject(): Record<string, Thread[]> {
  // The pure selector is memoized by its input references, so `useShallow`
  // ends up doing the equality check on stable objects — and React skips
  // the re-render when nothing changed.
  return useThreadStore(useShallow(selectThreadsByProject));
}
