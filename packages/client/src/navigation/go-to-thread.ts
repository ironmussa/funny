/**
 * `goToThread` — the single entry point for navigating to a thread from the UI.
 *
 * Consolidates the project-expansion + hydration + navigation dance that was
 * previously duplicated across ThreadList, RunningThreads, RecentThreads, and
 * the inbox. UI callers MUST use this (or `<Link to={buildThreadPath(thread)} />`)
 * instead of calling `selectThread()` and `navigate()` separately.
 *
 * Why a facade: navigation IS selection. Today selection is still a store
 * pointer (`selectedThreadId`) hydrated by `selectThread`, so the facade kicks
 * that hydration internally — but it does so in ONE place. The route-driven
 * migration (see `docs/route-driven-threads-plan.md`) later swaps the internal
 * `selectThread` for the route boundary's `ensureLoaded` and derives selection
 * from `useParams()`; callers of `goToThread` stay unchanged across that move.
 *
 * Branch-checkout preflight (local worktree switches) stays at the call site
 * that owns the confirm dialog — call `goToThread` once the preflight resolves.
 *
 * @internal `selectThread` is the legacy hydrator. Do not call it from
 * components; go through `goToThread` / `useGoToThread`.
 */

import type { Thread } from '@funny/shared';
import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { isScratch } from '@/lib/thread-variant';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { buildThreadPath, type ThreadRouteTarget } from './thread-paths';

export interface GoToThreadOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /**
   * Skip the hydration kick (the caller already prefetched / selected this
   * thread). Navigation still happens.
   */
  skipSelect?: boolean;
}

/**
 * Navigate to a thread's detail view, expanding/selecting its project and
 * kicking hydration so the fetch overlaps route-sync.
 */
export function goToThread(
  navigate: NavigateFunction,
  thread: ThreadRouteTarget,
  opts: GoToThreadOptions = {},
): void {
  const scratch = isScratch(thread);

  // Expand + select the owning project so the sidebar row is mounted and the
  // auto-scroll effect fires once with project + thread in the same batch.
  // Without the eager selectProject, the scroll effect runs first for the
  // project change (jump to header) and again later when route-sync resolves
  // the thread fetch — the visible "jump to project, then jump to thread".
  if (!scratch && thread.projectId) {
    const projectStore = useProjectStore.getState();
    if (!projectStore.expandedProjects.has(thread.projectId)) {
      projectStore.toggleProject(thread.projectId);
    }
    if (projectStore.selectedProjectId !== thread.projectId) {
      projectStore.selectProject(thread.projectId);
    }
  }

  // Kick hydration before navigate so the network fetch overlaps route-sync
  // instead of waiting for useThreadProjectSync's effect. `selectThread`
  // updates `selectedThreadId` urgently and defers the heavy chat mount.
  if (!opts.skipSelect) {
    const store = useThreadStore.getState();
    if (store.selectedThreadId !== thread.id || store.activeThread?.id !== thread.id) {
      void store.selectThread(thread.id);
    }
  }

  // Keep the bare `navigate(path)` form when not replacing so the call is
  // identical to the pre-facade call sites (no behavior drift).
  if (opts.replace) {
    navigate(buildThreadPath(thread), { replace: true });
  } else {
    navigate(buildThreadPath(thread));
  }
}

/**
 * Hook form of {@link goToThread}, bound to a referentially-stable navigate.
 * Prefer this in components.
 */
export function useGoToThread(): (thread: ThreadRouteTarget, opts?: GoToThreadOptions) => void {
  const navigate = useStableNavigate();
  return useCallback(
    (thread: ThreadRouteTarget, opts?: GoToThreadOptions) => goToThread(navigate, thread, opts),
    [navigate],
  );
}

/** Re-export so callers can `<Link to={buildThreadPath(thread)} />` from one module. */
export { buildThreadPath };
export type { ThreadRouteTarget, Thread };
