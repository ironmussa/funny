/**
 * Maximum number of columns/rows the live-grid view will allow. Shared so
 * LiveColumnsView, GridPicker, and the drop-target components agree on the
 * cap (and the parent doesn't import these constants from a child).
 */
export const MAX_GRID_COLS = 5;
export const MAX_GRID_ROWS = 5;

/** localStorage keys for the grid's persisted column / row counts. */
export const GRID_COLS_KEY = 'funny:grid-cols:v1';
export const GRID_ROWS_KEY = 'funny:grid-rows:v1';
