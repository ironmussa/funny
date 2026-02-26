import { create } from 'zustand';

export interface PreviewTab {
  /** The startup command ID */
  commandId: string;
  /** The project this belongs to */
  projectId: string;
  /** The port being previewed */
  port: number;
  /** Display name */
  label: string;
}

interface PreviewState {
  /** All open preview tabs */
  tabs: PreviewTab[];
  /** Currently active tab commandId */
  activeTabId: string | null;
  /** Whether the preview browser window is open */
  windowOpen: boolean;

  addTab: (tab: PreviewTab) => void;
  removeTab: (commandId: string) => void;
  removeTabsForProject: (projectId: string) => void;
  setActiveTab: (commandId: string) => void;
  setWindowOpen: (open: boolean) => void;
  hasTab: (commandId: string) => boolean;
  getTab: (commandId: string) => PreviewTab | undefined;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  windowOpen: false,

  addTab: (tab) =>
    set((state) => {
      // Don't add duplicates
      if (state.tabs.some((t) => t.commandId === tab.commandId)) {
        return { activeTabId: tab.commandId };
      }
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.commandId,
      };
    }),

  removeTab: (commandId) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.commandId !== commandId);
      const activeTabId =
        state.activeTabId === commandId
          ? (remaining[remaining.length - 1]?.commandId ?? null)
          : state.activeTabId;
      return { tabs: remaining, activeTabId };
    }),

  removeTabsForProject: (projectId) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.projectId !== projectId);
      const activeTabId = remaining.some((t) => t.commandId === state.activeTabId)
        ? state.activeTabId
        : (remaining[remaining.length - 1]?.commandId ?? null);
      return { tabs: remaining, activeTabId };
    }),

  setActiveTab: (commandId) => set({ activeTabId: commandId }),

  setWindowOpen: (open) => set({ windowOpen: open }),

  hasTab: (commandId) => get().tabs.some((t) => t.commandId === commandId),

  getTab: (commandId) => get().tabs.find((t) => t.commandId === commandId),
}));
