export const FILE_TREE_ESTIMATED_ROW_HEIGHT = 25;
export const FILE_TREE_OVERSCAN_ROWS = 6;
export const FILE_TREE_MIN_RETAINED_ROWS = 16;
export const FILE_TREE_MAX_RETAINED_ROWS = 160;
export const FILE_TREE_NATIVE_OVERDRAW = FILE_TREE_ESTIMATED_ROW_HEIGHT * 3;

function clampRetainedRows(count: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(
    itemCount,
    FILE_TREE_MAX_RETAINED_ROWS,
    Math.max(FILE_TREE_MIN_RETAINED_ROWS, count),
  );
}

export function fileTreeWindowSizeForViewport(viewportHeight: number, itemCount: number): number {
  const safeHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const visibleRows = Math.max(1, Math.ceil(safeHeight / FILE_TREE_ESTIMATED_ROW_HEIGHT));
  return clampRetainedRows(visibleRows + FILE_TREE_OVERSCAN_ROWS * 2, itemCount);
}

export function fileTreeWindowSizeForVisibleRange(
  visibleStart: number,
  visibleEnd: number,
  itemCount: number,
): number {
  const safeStart = Number.isFinite(visibleStart) ? Math.max(0, Math.floor(visibleStart)) : 0;
  const safeEnd = Number.isFinite(visibleEnd)
    ? Math.max(safeStart + 1, Math.ceil(visibleEnd))
    : safeStart + 1;
  const visibleRows = Math.min(itemCount, safeEnd) - Math.min(itemCount, safeStart);
  return clampRetainedRows(Math.max(1, visibleRows) + FILE_TREE_OVERSCAN_ROWS * 2, itemCount);
}
