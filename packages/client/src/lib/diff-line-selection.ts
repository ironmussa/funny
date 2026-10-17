/**
 * Pure helpers for line-level diff selection (partial staging). Every helper
 * returns a NEW set and never mutates its inputs.
 */

export type LineSelectionState = 'all' | 'partial' | 'none';

/** Summarize a selection relative to the number of selectable lines. */
export function selectionStateOf(
  selected: Set<number>,
  totalSelectable: number,
): LineSelectionState {
  if (selected.size === 0) return 'none';
  return selected.size === totalSelectable ? 'all' : 'partial';
}

/** Flip a single line in or out of the selection. */
export function toggleLine(selected: Set<number>, lineIdx: number): Set<number> {
  const next = new Set(selected);
  if (next.has(lineIdx)) next.delete(lineIdx);
  else next.add(lineIdx);
  return next;
}

/** Deselect the whole hunk when it is fully selected, otherwise select all of it. */
export function toggleHunk(selected: Set<number>, hunkLineIndices: number[]): Set<number> {
  const next = new Set(selected);
  const allSelected = hunkLineIndices.every((idx) => next.has(idx));
  for (const idx of hunkLineIndices) {
    if (allSelected) next.delete(idx);
    else next.add(idx);
  }
  return next;
}

/**
 * Apply a drag gesture: starting from the selection snapshot taken when the
 * drag began, select (or deselect) every changeable line between the two
 * endpoints (inclusive, in either order). Lines outside the range keep their
 * snapshot state.
 */
export function applyDragRange(
  snapshot: Set<number>,
  changeable: Iterable<number>,
  startLineIdx: number,
  endLineIdx: number,
  select: boolean,
): Set<number> {
  const lo = Math.min(startLineIdx, endLineIdx);
  const hi = Math.max(startLineIdx, endLineIdx);
  const next = new Set(snapshot);
  for (const idx of changeable) {
    if (idx < lo || idx > hi) continue;
    if (select) next.add(idx);
    else next.delete(idx);
  }
  return next;
}
