import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ImageLightbox } from '@/components/ImageLightbox';
import { EmptyGridCell } from '@/components/live-columns/EmptyGridCell';
import {
  GRID_COLS_KEY,
  GRID_ROWS_KEY,
  MAX_GRID_COLS,
  MAX_GRID_ROWS,
} from '@/components/live-columns/grid-constants';
import { withoutColumn } from '@/components/live-columns/grid-layout';
import { GridCellDropTarget } from '@/components/live-columns/GridCellDropTarget';
import { GridColumnInsertDropTarget } from '@/components/live-columns/GridColumnInsertDropTarget';
import { GridToolbar } from '@/components/live-columns/GridToolbar';
import { ProjectPickerDialog } from '@/components/live-columns/ProjectPickerDialog';
import { ThreadColumn } from '@/components/live-columns/ThreadColumn';
import { useGridDragMonitor } from '@/components/live-columns/use-grid-drag-monitor';
import { useGridNewColumnShortcut } from '@/components/live-columns/use-grid-new-column-shortcut';
import { fetchForThread } from '@/data/git-status/actions';
import { useProjects } from '@/data/projects/hooks';
import { isProjectListed } from '@/data/threads/read';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { createClientLogger } from '@/lib/client-logger';
import { firstPlacedThreadId, resolveGridSelection } from '@/lib/grid-selection';
import { GRID_CELLS_KEY, getGridCells, type GridCellAssignments } from '@/lib/grid-storage';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('LiveColumnsView');

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

export function LiveColumnsView() {
  const { t } = useTranslation();
  useMinuteTick();
  const projects = useProjects();
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const [gridCols, setGridCols] = useState(() => {
    const saved = localStorage.getItem(GRID_COLS_KEY);
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_COLS) : 2;
  });
  const [gridRows, setGridRows] = useState(() => {
    const saved = localStorage.getItem(GRID_ROWS_KEY);
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_ROWS) : 2;
  });

  // Load threads once for any project that hasn't been loaded yet (no polling —
  // WS events keep the store in sync after the initial load).
  const projectIdsKey = useMemo(() => projects.map((p) => p.id).join(','), [projects]);
  useEffect(() => {
    for (const projectId of projectIdsKey.split(',')) {
      if (projectId && !isProjectListed(projectId)) {
        loadThreadsForProject(projectId);
      }
    }
  }, [projectIdsKey, loadThreadsForProject]);

  // --- Image lightbox (shared across all columns) ---
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const openLightbox = useCallback<OpenLightboxFn>((images, index) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const [gridCells, setGridCells] = useState<GridCellAssignments>(getGridCells);
  // Threads currently placed in the grid — used by the per-cell thread picker
  // to flag entries that are already on screen.
  const gridThreadIds = useMemo(() => new Set(Object.values(gridCells)), [gridCells]);

  // --- Selected thread (drives the consolidated header actions + right pane) ---
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  const setGridSelectedThreadId = useUIStore((s) => s.setGridSelectedThreadId);
  const initedSelectionRef = useRef(false);
  const prevHadThreadsRef = useRef(false);

  // Keep the selection valid and auto-select the first occupied cell at
  // load time (and when threads first appear in a previously-empty grid).
  // Removing the selected cell strict-clears (no auto-jump) — handled here by
  // only auto-selecting on initial resolution / empty→non-empty transitions.
  useEffect(() => {
    const current = useUIStore.getState().gridSelectedThreadId;
    const next = resolveGridSelection({
      current,
      placedIds: gridThreadIds,
      firstPlaced: firstPlacedThreadId(gridCells, gridCols, gridRows),
      inited: initedSelectionRef.current,
      prevHadThreads: prevHadThreadsRef.current,
    });
    if (next !== current) setGridSelectedThreadId(next);
    initedSelectionRef.current = true;
    prevHadThreadsRef.current = gridThreadIds.size > 0;
  }, [gridThreadIds, gridCells, gridCols, gridRows, setGridSelectedThreadId]);

  // The grid is full-screen, so ProjectHeader's git-status fetch never runs
  // here — fetch for the selected thread so the right pane (review/files) has
  // data to show.
  useEffect(() => {
    if (gridSelectedThreadId) fetchForThread(gridSelectedThreadId);
  }, [gridSelectedThreadId]);
  // Tracks cells where the user has pre-selected a project (via the header
  // "+") but hasn't typed a prompt yet. The EmptyGridCell uses this to skip
  // the project picker and jump straight to the prompt input — same flow as
  // clicking "New thread" in an empty cell.
  const [pendingProjectByCell, setPendingProjectByCell] = useState<Record<number, string>>({});

  // Shared project-picker dialog. The same modal is used by the header "+",
  // the per-cell "New thread" button, and the Ctrl+N shortcut. The target
  // tells us what to do once the user picks a project.
  const [pickerTarget, setPickerTarget] = useState<
    { kind: 'new-column' } | { kind: 'cell'; cellIndex: number } | null
  >(null);

  useEffect(() => {
    localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(gridCells));
  }, [gridCells]);

  const consumePreset = useCallback((cellIndex: number) => {
    setPendingProjectByCell((prev) => {
      if (!(cellIndex in prev)) return prev;
      const updated = { ...prev };
      delete updated[cellIndex];
      return updated;
    });
  }, []);

  const presetProjectInCell = useCallback((cellIndex: number, projectId: string) => {
    setPendingProjectByCell((prev) => ({ ...prev, [cellIndex]: projectId }));
  }, []);

  const assignThreadToCell = useCallback(
    (cellIndex: number, threadId: string) => {
      setGridCells((prev) => {
        const updated = { ...prev };
        for (const [key, val] of Object.entries(updated)) {
          if (val === threadId) delete updated[key];
        }
        updated[String(cellIndex)] = threadId;
        return updated;
      });
      // Focus the freshly placed thread (created or loaded) so its header
      // action icons surface — auto-select otherwise only fires on the
      // empty→non-empty transition, leaving new threads in a populated grid
      // unselected.
      setGridSelectedThreadId(threadId);
    },
    [setGridSelectedThreadId],
  );
  const handleRemoveFromGrid = useCallback(
    (cellIndex: number) => {
      const updated = { ...gridCells };
      delete updated[String(cellIndex)];

      const col = cellIndex % gridCols;

      if (gridCols <= 1) {
        setGridCells(updated);
        return;
      }

      const columnEmpty = Array.from({ length: gridRows }).every((_, r) => {
        const idx = r * gridCols + col;
        return !updated[String(idx)];
      });

      if (!columnEmpty) {
        setGridCells(updated);
        return;
      }

      const newCols = gridCols - 1;
      setGridCells(withoutColumn(updated, col, gridCols));
      setGridCols(newCols);
      setPendingProjectByCell((prevPending) => withoutColumn(prevPending, col, gridCols));
      localStorage.setItem(GRID_COLS_KEY, String(newCols));
    },
    [gridCells, gridCols, gridRows],
  );

  // Header "+" flow: pick a project, append a new empty column, and pre-select
  // the project in the new column's top cell. The user types a prompt there to
  // create a fully-initialized thread (same flow as EmptyGridCell). No draft
  // thread is created up front.
  const handleAddColumnWithProject = useCallback(
    (pid: string) => {
      if (gridCols >= MAX_GRID_COLS) {
        toast.info(t('live.gridFull', 'Grid is full'));
        return;
      }
      const oldCols = gridCols;
      const newCols = oldCols + 1;
      const insertIndex = oldCols;

      setGridCells((prev) => {
        const updated: GridCellAssignments = {};
        for (const [key, val] of Object.entries(prev)) {
          const oldIdx = Number(key);
          const oldCol = oldIdx % oldCols;
          const oldRow = Math.floor(oldIdx / oldCols);
          updated[String(oldRow * newCols + oldCol)] = val;
        }
        return updated;
      });
      setPendingProjectByCell((prev) => {
        const updated: Record<number, string> = {};
        for (const [key, val] of Object.entries(prev)) {
          const oldIdx = Number(key);
          const oldCol = oldIdx % oldCols;
          const oldRow = Math.floor(oldIdx / oldCols);
          updated[oldRow * newCols + oldCol] = val;
        }
        updated[insertIndex] = pid;
        return updated;
      });
      setGridCols(newCols);
      localStorage.setItem(GRID_COLS_KEY, String(newCols));
      log.info({ projectId: pid, cellIndex: insertIndex }, 'header preset project for new column');
    },
    [gridCols, t],
  );

  const handlePickerSelect = useCallback(
    (projectId: string) => {
      const target = pickerTarget;
      if (!target) return;
      if (target.kind === 'new-column') {
        handleAddColumnWithProject(projectId);
      } else {
        presetProjectInCell(target.cellIndex, projectId);
      }
      setPickerTarget(null);
    },
    [pickerTarget, handleAddColumnWithProject, presetProjectInCell],
  );
  const openNewColumnPicker = useCallback(() => setPickerTarget({ kind: 'new-column' }), []);
  useGridNewColumnShortcut(gridCols, openNewColumnPicker);

  const isDragging = useGridDragMonitor({
    gridCols,
    t,
    setGridCells,
    setPendingProjectByCell,
    setGridCols,
  });

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="grid-view">
      <GridToolbar
        gridCols={gridCols}
        gridRows={gridRows}
        setGridCols={setGridCols}
        setGridRows={setGridRows}
        gridSelectedThreadId={gridSelectedThreadId}
        onNewColumn={openNewColumnPicker}
      />

      <div
        data-testid="grid-container"
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2"
      >
        <div className="flex h-full">
          <GridColumnInsertDropTarget
            insertIndex={0}
            isDragging={isDragging}
            disabled={gridCols >= MAX_GRID_COLS}
          />
          {Array.from({ length: gridCols }).flatMap((_, c) => [
            <div
              key={`col-${c}`}
              className="flex h-full min-w-[280px] flex-1 flex-col gap-2"
              data-testid={`grid-col-${c}`}
            >
              {Array.from({ length: gridRows }, (_, r) => {
                const cellIndex = r * gridCols + c;
                const threadId = gridCells[String(cellIndex)];
                return (
                  <GridCellDropTarget
                    key={threadId ? `col-${threadId}` : `empty-${cellIndex}`}
                    cellIndex={cellIndex}
                  >
                    {threadId ? (
                      <ThreadColumn
                        threadId={threadId}
                        cellIndex={cellIndex}
                        onRemove={handleRemoveFromGrid}
                        onOpenLightbox={openLightbox}
                      />
                    ) : (
                      // Isolate the compose cell from the app-level thread
                      // context (which follows the grid-selected thread) — a new
                      // thread must not inherit the selected thread's queue /
                      // context. See `grid-thread-actions`.
                      <ThreadProvider threadId={null}>
                        <EmptyGridCell
                          cellIndex={cellIndex}
                          onCreated={(newThreadId) => assignThreadToCell(cellIndex, newThreadId)}
                          onLoadExisting={(existingId) => assignThreadToCell(cellIndex, existingId)}
                          initialProjectId={pendingProjectByCell[cellIndex]}
                          onConsumePreset={() => consumePreset(cellIndex)}
                          onRequestPickProject={() => setPickerTarget({ kind: 'cell', cellIndex })}
                          gridThreadIds={gridThreadIds}
                        />
                      </ThreadProvider>
                    )}
                  </GridCellDropTarget>
                );
              })}
            </div>,
            <GridColumnInsertDropTarget
              key={`insert-${c + 1}`}
              insertIndex={c + 1}
              isDragging={isDragging}
              disabled={gridCols >= MAX_GRID_COLS}
            />,
          ])}
        </div>
      </div>

      <ProjectPickerDialog
        open={pickerTarget !== null}
        onOpenChange={(v) => {
          if (!v) setPickerTarget(null);
        }}
        onSelect={handlePickerSelect}
      />

      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}
