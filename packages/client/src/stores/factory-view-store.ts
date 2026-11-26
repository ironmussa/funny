/**
 * The factory view's layout, list, board or analytics (openspec
 * factory-pipeline-board, D4), and the board columns the user hid, kept
 * across visits in localStorage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FactoryViewLayout = 'list' | 'board' | 'analytics';

interface FactoryViewState {
  layout: FactoryViewLayout;
  setLayout: (layout: FactoryViewLayout) => void;
  /** Board column ids the user hid (`FactoryBoardColumnId`). */
  hiddenColumns: string[];
  setColumnHidden: (column: string, hidden: boolean) => void;
  showAllColumns: () => void;
}

export const useFactoryViewStore = create<FactoryViewState>()(
  persist(
    (set) => ({
      layout: 'list',
      setLayout: (layout) => set({ layout }),
      hiddenColumns: [],
      setColumnHidden: (column, hidden) =>
        set((state) => {
          const rest = state.hiddenColumns.filter((id) => id !== column);
          return { hiddenColumns: hidden ? [...rest, column] : rest };
        }),
      showAllColumns: () => set({ hiddenColumns: [] }),
    }),
    {
      name: 'funny:factory-view-layout',
      partialize: (state) => ({ layout: state.layout, hiddenColumns: state.hiddenColumns }),
    },
  ),
);
