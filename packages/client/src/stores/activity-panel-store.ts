import { create } from 'zustand';

/** Open state of the sidebar footer's activity panel (Activity · Jobs · Watchers). */

export type ActivityPanelTab = 'activity' | 'jobs' | 'watchers';

interface ActivityPanelState {
  open: boolean;
  tab: ActivityPanelTab;
  setOpen: (open: boolean) => void;
  setTab: (tab: ActivityPanelTab) => void;
  /** Opens the panel on a tab (the failure toast's action). */
  openOn: (tab: ActivityPanelTab) => void;
}

export const useActivityPanelStore = create<ActivityPanelState>((set) => ({
  open: false,
  tab: 'activity',
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
  openOn: (tab) => set({ open: true, tab }),
}));
