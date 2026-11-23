/**
 * The factory view's layout, list or board (openspec factory-pipeline-board,
 * D4), kept across visits in localStorage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FactoryViewLayout = 'list' | 'board';

interface FactoryViewState {
  layout: FactoryViewLayout;
  setLayout: (layout: FactoryViewLayout) => void;
}

export const useFactoryViewStore = create<FactoryViewState>()(
  persist(
    (set) => ({
      layout: 'list',
      setLayout: (layout) => set({ layout }),
    }),
    { name: 'funny:factory-view-layout', partialize: (state) => ({ layout: state.layout }) },
  ),
);
