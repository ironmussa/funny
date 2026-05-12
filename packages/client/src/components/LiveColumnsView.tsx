import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { LayoutGrid, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ImageLightbox } from '@/components/ImageLightbox';
import { EmptyGridCell } from '@/components/live-columns/EmptyGridCell';
import { MAX_GRID_COLS, MAX_GRID_ROWS } from '@/components/live-columns/grid-constants';
import { GridCellDropTarget } from '@/components/live-columns/GridCellDropTarget';
import { GridColumnInsertDropTarget } from '@/components/live-columns/GridColumnInsertDropTarget';
import { GridPicker } from '@/components/live-columns/GridPicker';
import { ProjectPickerDialog } from '@/components/live-columns/ProjectPickerDialog';
import { ThreadColumn } from '@/components/live-columns/ThreadColumn';
import { Button } from '@/components/ui/button';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { createClientLogger } from '@/lib/client-logger';
import { GRID_CELLS_KEY, getGridCells, type GridCellAssignments } from '@/lib/grid-storage';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('LiveColumnsView');

const GRID_COLS_KEY = 'funny:grid-cols:v1';
const GRID_ROWS_KEY = 'funny:grid-rows:v1';

type OpenLightboxFn = (images: { src: string; alt: string }[], index: number) => void;

export function LiveColumnsView() {
  const { t } = useTranslation();
  useMinuteTick();
  const projects = useProjectStore((s) => s.projects);
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
    const state = useThreadStore.getState();
    for (const project of projects) {
      if (!state.threadsByProject[project.id]) {
        loadThreadsForProject(project.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey]);

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

  const assignThreadToCell = useCallback((cellIndex: number, threadId: string) => {
    setGridCells((prev) => {
      const updated = { ...prev };
      for (const [key, val] of Object.entries(updated)) {
        if (val === threadId) delete updated[key];
      }
      updated[String(cellIndex)] = threadId;
      localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleRemoveFromGrid = useCallback(
    (cellIndex: number) => {
      setGridCells((prev) => {
        const updated = { ...prev };
        delete updated[String(cellIndex)];

        const col = cellIndex % gridCols;

        if (gridCols <= 1) {
          localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
          return updated;
        }

        const columnEmpty = Array.from({ length: gridRows }).every((_, r) => {
          const idx = r * gridCols + col;
          return !updated[String(idx)];
        });

        if (!columnEmpty) {
          localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
          return updated;
        }

        const newCols = gridCols - 1;
        const collapsed: GridCellAssignments = {};
        for (const [key, val] of Object.entries(updated)) {
          const oldIdx = Number(key);
          const oldCol = oldIdx % gridCols;
          const oldRow = Math.floor(oldIdx / gridCols);
          if (oldCol === col) continue;
          const newCol = oldCol > col ? oldCol - 1 : oldCol;
          collapsed[String(oldRow * newCols + newCol)] = val;
        }
        setGridCols(newCols);
        setPendingProjectByCell((prevPending) => {
          const remapped: Record<number, string> = {};
          for (const [key, val] of Object.entries(prevPending)) {
            const oldIdx = Number(key);
            const oldCol = oldIdx % gridCols;
            const oldRow = Math.floor(oldIdx / gridCols);
            if (oldCol === col) continue;
            const newCol = oldCol > col ? oldCol - 1 : oldCol;
            remapped[oldRow * newCols + newCol] = val;
          }
          return remapped;
        });
        localStorage.setItem(GRID_COLS_KEY, String(newCols));
        localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(collapsed));
        return collapsed;
      });
    },
    [gridCols, gridRows],
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
        localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
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

  // Alt+N opens the project picker for a new column (mirrors the header "+").
  // Scoped to LiveColumnsView so it only fires while the grid is mounted.
  // Uses capture phase + stopImmediatePropagation to override the global Alt+N.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'n' && e.key !== 'N') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      if (gridCols >= MAX_GRID_COLS) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      log.info('shortcut.grid_new_thread');
      setPickerTarget({ kind: 'new-column' });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [gridCols]);

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
        const threadId = source.data.threadId as string;

        if (targetData.type === 'grid-cell') {
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
            localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
            return updated;
          });
          return;
        }

        if (targetData.type === 'grid-col-insert') {
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
            localStorage.setItem(GRID_CELLS_KEY, JSON.stringify(updated));
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
  }, [gridCols, t]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="grid-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <LayoutGrid className="icon-sm text-muted-foreground" /> {t('live.title', 'Grid')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          data-testid="grid-new-thread"
          disabled={gridCols >= MAX_GRID_COLS}
          onClick={() => setPickerTarget({ kind: 'new-column' })}
        >
          <Plus className="icon-base" />
        </Button>

        <div className="ml-auto">
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
        </div>
      </div>

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
                        onRemove={() => handleRemoveFromGrid(cellIndex)}
                        onOpenLightbox={openLightbox}
                      />
                    ) : (
                      <EmptyGridCell
                        cellIndex={cellIndex}
                        onCreated={(newThreadId) => assignThreadToCell(cellIndex, newThreadId)}
                        initialProjectId={pendingProjectByCell[cellIndex]}
                        onConsumePreset={() => consumePreset(cellIndex)}
                        onRequestPickProject={() => setPickerTarget({ kind: 'cell', cellIndex })}
                      />
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
