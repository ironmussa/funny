import type { GridCellAssignments } from '@/lib/grid-storage';

/** The thread in the first occupied cell, scanning row-major. Null if empty. */
export function firstPlacedThreadId(
  cells: GridCellAssignments,
  cols: number,
  rows: number,
): string | null {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = cells[String(r * cols + c)];
      if (id) return id;
    }
  }
  return null;
}

interface ResolveArgs {
  /** The currently selected thread id (or null). */
  current: string | null;
  /** The set of thread ids currently placed in the grid. */
  placedIds: Set<string>;
  /** The first occupied cell's thread id, row-major (or null). */
  firstPlaced: string | null;
  /** Whether the initial selection resolution has already run. */
  inited: boolean;
  /** Whether the previous run had any placed threads. */
  prevHadThreads: boolean;
}

/**
 * Pure resolution of the grid's selected thread, applied on every cell change.
 *
 * Rules (see the `grid-thread-actions` change):
 * - A selection that's no longer placed (removed / reshuffled out / stale on
 *   reload) is strict-cleared to null — no auto-jump to a sibling.
 * - The first occupied cell is auto-selected ONLY at the initial resolution
 *   (mount / reload) or when threads first appear in a previously-empty grid.
 *   This keeps "a 1×1 grid always has its thread selected" while honoring
 *   "removing the selected cell clears the selection".
 */
export function resolveGridSelection({
  current,
  placedIds,
  firstPlaced,
  inited,
  prevHadThreads,
}: ResolveArgs): string | null {
  let sel = current;
  if (sel && !placedIds.has(sel)) sel = null;
  const hasThreads = placedIds.size > 0;
  const firstAppear = !prevHadThreads && hasThreads;
  if (!sel && hasThreads && (!inited || firstAppear)) {
    sel = firstPlaced;
  }
  return sel;
}
