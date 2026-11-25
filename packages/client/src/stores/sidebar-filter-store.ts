import { create } from 'zustand';

/** localStorage key of the sidebar's "hide factory threads" toggle. */
const HIDE_FACTORY_KEY = 'funny:sidebar-hide-factory-threads';

/** Hidden unless the user chose to show them. */
function readHideFactory(): boolean {
  try {
    return localStorage.getItem(HIDE_FACTORY_KEY) !== '0';
  } catch {
    return true;
  }
}

interface SidebarFilterState {
  /** Hide the threads the issue factory started from the sidebar (Activity and project lists). */
  hideFactoryThreads: boolean;
  toggleHideFactoryThreads: () => void;
}

/** What the sidebar leaves out of its thread lists, kept across reloads. */
export const useSidebarFilterStore = create<SidebarFilterState>()((set, get) => ({
  hideFactoryThreads: readHideFactory(),
  toggleHideFactoryThreads: () => {
    const next = !get().hideFactoryThreads;
    set({ hideFactoryThreads: next });
    try {
      localStorage.setItem(HIDE_FACTORY_KEY, next ? '1' : '0');
    } catch {
      /* localStorage unavailable */
    }
  },
}));
