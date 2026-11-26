/**
 * Drops column `col` from a cell-index → value map laid out with `oldCols`
 * columns, shifting the columns to its right one step left.
 */
export function withoutColumn(assignments: Record<string, string>, col: number, oldCols: number) {
  const newCols = oldCols - 1;
  return Object.fromEntries(
    Object.entries(assignments).flatMap(([key, val]) => {
      const oldIdx = Number(key);
      const oldCol = oldIdx % oldCols;
      const oldRow = Math.floor(oldIdx / oldCols);
      if (oldCol === col) return [];
      const newCol = oldCol > col ? oldCol - 1 : oldCol;
      return [[String(oldRow * newCols + newCol), val] as const];
    }),
  );
}

/**
 * Inserts an empty column at `insertIndex` into a cell-index → value map laid
 * out with `oldCols` columns, shifting columns at or to the right of
 * `insertIndex` one step right.
 */
export function withInsertedColumn(
  assignments: Record<string, string>,
  insertIndex: number,
  oldCols: number,
) {
  const newCols = oldCols + 1;
  return Object.fromEntries(
    Object.entries(assignments).map(([key, val]) => {
      const oldIdx = Number(key);
      const oldCol = oldIdx % oldCols;
      const oldRow = Math.floor(oldIdx / oldCols);
      const newCol = oldCol < insertIndex ? oldCol : oldCol + 1;
      return [String(oldRow * newCols + newCol), val] as const;
    }),
  );
}

/** Creates `count` fresh column IDs using `nextId`. */
export function createColumnIds(count: number, nextId: () => string): string[] {
  return Array.from({ length: count }, () => nextId());
}

/**
 * Resizes a list of stable column IDs to `nextCount`, keeping existing IDs in
 * place so surviving columns don't remount.
 */
export function resizeColumnIds(ids: string[], nextCount: number, nextId: () => string): string[] {
  if (nextCount <= ids.length) return ids.slice(0, nextCount);
  return [...ids, ...createColumnIds(nextCount - ids.length, nextId)];
}

/** Removes the column ID at `col`, preserving the IDs of all other columns. */
export function removeColumnId(ids: string[], col: number): string[] {
  return ids.filter((_, index) => index !== col);
}

/** Inserts `id` at `insertIndex`, preserving the IDs of all other columns. */
export function insertColumnId(ids: string[], insertIndex: number, id: string): string[] {
  return [...ids.slice(0, insertIndex), id, ...ids.slice(insertIndex)];
}
