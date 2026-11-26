import { Plus } from 'lucide-react';

import {
  GRID_COLS_KEY,
  GRID_ROWS_KEY,
  MAX_GRID_COLS,
} from '@/components/live-columns/grid-constants';
import { GridPicker } from '@/components/live-columns/GridPicker';
import { ThreadHeaderActions } from '@/components/thread/ProjectHeader';
import { Button } from '@/components/ui/button';
import { ThreadProvider } from '@/stores/thread-context';

interface GridToolbarProps {
  gridCols: number;
  gridRows: number;
  setGridCols: (cols: number) => void;
  setGridRows: (rows: number) => void;
  gridSelectedThreadId: string | null;
  onNewColumn: () => void;
}

export function GridToolbar({
  gridCols,
  gridRows,
  setGridCols,
  setGridRows,
  gridSelectedThreadId,
  onNewColumn,
}: GridToolbarProps) {
  return (
    <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2">
      <Button
        variant="outline"
        size="icon"
        className="size-7"
        data-testid="grid-new-thread"
        disabled={gridCols >= MAX_GRID_COLS}
        onClick={onNewColumn}
      >
        <Plus className="icon-base" />
      </Button>
      <GridPicker
        cols={gridCols}
        rows={gridRows}
        onChange={(c, r) => {
          setGridCols(c);
          setGridRows(r);
          localStorage.setItem(GRID_COLS_KEY, String(c));
          localStorage.setItem(GRID_ROWS_KEY, String(r));
        }}
      />

      {/* Consolidated thread actions — act on the selected thread. Hidden
          when nothing is selected (empty grid). */}
      {gridSelectedThreadId && (
        <div className="ml-auto flex items-center gap-2" data-testid="grid-thread-actions">
          <ThreadProvider threadId={gridSelectedThreadId}>
            <ThreadHeaderActions hideTimeline />
          </ThreadProvider>
        </div>
      )}
    </div>
  );
}
