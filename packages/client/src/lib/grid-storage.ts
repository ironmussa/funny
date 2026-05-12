/**
 * localStorage utilities for persisting grid cell → thread assignments.
 *
 * Key: `funny:grid-cells:v1`
 * Value: JSON object mapping cell index (string) → threadId.
 *   e.g. { "0": "abc-123", "2": "def-456" }
 *
 * The `:v1` suffix lets a future schema change ignore old data instead of
 * crashing when it can't parse it.
 */

export const GRID_CELLS_KEY = 'funny:grid-cells:v1';
const STORAGE_KEY = GRID_CELLS_KEY;

export type GridCellAssignments = Record<string, string>;

export function getGridCells(): GridCellAssignments {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GridCellAssignments) : {};
  } catch {
    return {};
  }
}

export function setGridCell(cellIndex: number, threadId: string): GridCellAssignments {
  const cells = getGridCells();
  cells[String(cellIndex)] = threadId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cells));
  return cells;
}

export function clearGridCell(cellIndex: number): GridCellAssignments {
  const cells = getGridCells();
  delete cells[String(cellIndex)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cells));
  return cells;
}

export function getAssignedThreadIds(cells?: GridCellAssignments): string[] {
  const c = cells ?? getGridCells();
  return Object.values(c);
}
