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
