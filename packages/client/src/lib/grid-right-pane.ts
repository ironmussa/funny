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
 * Whether the right pane should render.
 *
 * Normally it's hidden under any full-screen view. The grid is full-screen too,
 * but it hosts the right pane in a sibling dockview slot, so let it through when
 * the grid is open AND a thread is selected.
 */
export function isRightPaneVisible(
  reviewPaneOpen: boolean,
  isFullScreenView: boolean,
  liveColumnsOpen: boolean,
  gridSelectedThreadId: string | null,
): boolean {
  return reviewPaneOpen && (!isFullScreenView || (liveColumnsOpen && !!gridSelectedThreadId));
}

/**
 * The project the right pane (review / files) should scope to.
 *
 * In the grid view this is the grid-selected thread's project (resolved from
 * thread context); otherwise the store's selected project. Like
 * {@link effectiveThreadId}, the grid value has NO effect outside the grid.
 */
export function rightPaneProjectId(
  liveColumnsOpen: boolean,
  gridThreadProjectId: string | null,
  selectedProjectId: string | null,
): string | null {
  return liveColumnsOpen ? gridThreadProjectId : selectedProjectId;
}
