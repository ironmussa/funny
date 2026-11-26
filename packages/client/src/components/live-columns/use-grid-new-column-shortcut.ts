import { useEffect } from 'react';

import { MAX_GRID_COLS } from '@/components/live-columns/grid-constants';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('LiveColumnsView');

/**
 * Alt+N opens the project picker for a new column (mirrors the header "+").
 * Scoped to LiveColumnsView so it only fires while the grid is mounted.
 * Uses capture phase + stopImmediatePropagation to override the global Alt+N.
 */
export function useGridNewColumnShortcut(gridCols: number, openNewColumnPicker: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'n' && e.key !== 'N') return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      if (gridCols >= MAX_GRID_COLS) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      log.info('shortcut.grid_new_thread');
      openNewColumnPicker();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [gridCols, openNewColumnPicker]);
}
