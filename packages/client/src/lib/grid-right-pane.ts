/**
 * Pure derivations for hosting the global right pane in the grid view, scoped
 * to the grid-selected thread. See the `grid-thread-actions` change.
 */

/**
 * The thread that drives the app-level thread context + right pane.
 *
 * While the grid is open it's the grid-selected thread (which has no URL);
 * otherwise it's the URL-derived active thread. Outside the grid the grid
 * selection has NO effect — this is the "no leak" guarantee.
 */
export function effectiveThreadId(
  liveColumnsOpen: boolean,
  gridSelectedThreadId: string | null,
  activeThreadId: string | null,
): string | null {
  return liveColumnsOpen ? gridSelectedThreadId : activeThreadId;
}

/**
 * Whether the right pane (and the tool rail's panels) can act.
 *
 * Hidden under a full-screen view that takes the whole window (settings,
 * workflows, the inbox…). The thread grid, analytics and the test runner are
 * not such views: they host the tools like the thread view does. The pane
 * also needs something to show: a thread or a selected project
 * (`hasContext`). With neither, every tab would be an empty state.
 */
export function isRightPaneVisible(
  reviewPaneOpen: boolean,
  hidesTools: boolean,
  hasContext: boolean,
): boolean {
  return reviewPaneOpen && !hidesTools && hasContext;
}

/**
 * The project the right pane (review / files) should scope to.
 *
 * In the grid view with a selected thread this is that thread's project
 * (resolved from thread context; `null` for a scratch thread); otherwise the
 * store's selected project. Like {@link effectiveThreadId}, the grid
 * selection has NO effect outside the grid.
 */
export function rightPaneProjectId(
  liveColumnsOpen: boolean,
  gridSelectedThreadId: string | null,
  gridThreadProjectId: string | null,
  selectedProjectId: string | null,
): string | null {
  return liveColumnsOpen && gridSelectedThreadId ? gridThreadProjectId : selectedProjectId;
}
