import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { TFunction } from 'i18next';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';

import { GRID_COLS_KEY, MAX_GRID_COLS } from '@/components/live-columns/grid-constants';
import type { GridCellAssignments } from '@/lib/grid-storage';

interface GridDragMonitorInput {
  gridCols: number;
  t: TFunction;
  setGridCells: Dispatch<SetStateAction<GridCellAssignments>>;
  setPendingProjectByCell: Dispatch<SetStateAction<Record<number, string>>>;
  setGridCols: Dispatch<SetStateAction<number>>;
}

/**
 * Moves grid threads on drop: onto a cell (swapping with its thread when the
 * drag started inside the grid) or into a new column. Returns whether a grid
 * thread is being dragged.
 */
export function useGridDragMonitor({
  gridCols,
  t,
  setGridCells,
  setPendingProjectByCell,
  setGridCols,
}: GridDragMonitorInput) {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => {
        if (source.data.type === 'grid-thread') setIsDragging(true);
      },
      onDrop: ({ source, location }) => {
        setIsDragging(false);
        if (source.data.type !== 'grid-thread') return;
        const targets = location.current.dropTargets;
        if (!targets.length) return;

        const targetData = targets[0].data;
        // SAFETY: every 'grid-thread' draggable (ThreadColumn, useGridThreadDrag)
        // puts the thread id string in `threadId`.
        const threadId = source.data.threadId as string;

        if (targetData.type === 'grid-cell') {
          // SAFETY: GridCellDropTarget's 'grid-cell' data carries its `cellIndex: number` prop.
          const cellIndex = targetData.cellIndex as number;
          setGridCells((prev) => {
            const updated = { ...prev };

            // Find the source cell index if it was already in the grid
            let sourceKey: string | undefined;
            for (const [key, val] of Object.entries(updated)) {
              if (val === threadId) {
                sourceKey = key;
                delete updated[key];
              }
            }

            // If the target cell already has a thread, and we are dragging from within the grid,
            // swap them. Otherwise, just overwrite/place.
            const existingThreadId = updated[String(cellIndex)];
            if (existingThreadId && sourceKey) {
              updated[sourceKey] = existingThreadId;
            }

            updated[String(cellIndex)] = threadId;
            return updated;
          });
          return;
        }

        if (targetData.type === 'grid-col-insert') {
          // SAFETY: GridColumnInsertDropTarget's 'grid-col-insert' data carries its
          // `insertIndex: number` prop.
          const insertIndex = targetData.insertIndex as number;
          if (gridCols >= MAX_GRID_COLS) {
            toast.info(t('live.gridFull', 'Grid is full'));
            return;
          }
          const oldCols = gridCols;
          const newCols = oldCols + 1;
          setGridCells((prev) => {
            const updated: GridCellAssignments = {};
            for (const [key, val] of Object.entries(prev)) {
              if (val === threadId) continue;
              const oldIdx = Number(key);
              const oldCol = oldIdx % oldCols;
              const oldRow = Math.floor(oldIdx / oldCols);
              const newCol = oldCol < insertIndex ? oldCol : oldCol + 1;
              const newIdx = oldRow * newCols + newCol;
              updated[String(newIdx)] = val;
            }
            updated[String(insertIndex)] = threadId;
            return updated;
          });
          setPendingProjectByCell((prevPending) => {
            const remapped: Record<number, string> = {};
            for (const [key, val] of Object.entries(prevPending)) {
              const oldIdx = Number(key);
              const oldCol = oldIdx % oldCols;
              const oldRow = Math.floor(oldIdx / oldCols);
              const newCol = oldCol < insertIndex ? oldCol : oldCol + 1;
              remapped[oldRow * newCols + newCol] = val;
            }
            return remapped;
          });
          setGridCols(newCols);
          localStorage.setItem(GRID_COLS_KEY, String(newCols));
        }
      },
    });
  }, [gridCols, t, setGridCells, setPendingProjectByCell, setGridCols]);

  return isDragging;
}
