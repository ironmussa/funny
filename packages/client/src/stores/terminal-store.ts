import { create } from 'zustand';

export interface TerminalTab {
  id: string;
  label: string;
  cwd: string;
  alive: boolean;
  /** Which project this terminal belongs to */
  projectId: string;
  /** If set, this tab is a server-managed command (not a Tauri PTY) */
  commandId?: string;
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  panelVisible: boolean;
  panelHeight: number;
  /** Output buffer per commandId for server-managed commands */
  commandOutput: Record<string, string>;

  addTab: (tab: TerminalTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  markExited: (id: string) => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanel: () => void;
  setPanelHeight: (height: number) => void;
  appendCommandOutput: (commandId: string, data: string) => void;
  markCommandExited: (commandId: string) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: [],
  activeTabId: null,
  panelVisible: false,
  panelHeight: 300,
  commandOutput: {},

  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      panelVisible: true,
    })),

  removeTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      const remaining = state.tabs.filter((t) => t.id !== id);
      const activeTabId =
        state.activeTabId === id
          ? (remaining[remaining.length - 1]?.id ?? null)
          : state.activeTabId;
      // Clean up command output buffer
      const commandOutput = { ...state.commandOutput };
      if (tab?.commandId) delete commandOutput[tab.commandId];
      return {
        tabs: remaining,
        activeTabId,
        panelVisible: remaining.length > 0 ? state.panelVisible : false,
        commandOutput,
      };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  markExited: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, alive: false } : t
      ),
    })),

  setPanelVisible: (visible) => set({ panelVisible: visible }),

  togglePanel: () =>
    set((state) => ({ panelVisible: !state.panelVisible })),

  setPanelHeight: (height) =>
    set({ panelHeight: Math.max(150, Math.min(height, 600)) }),

  appendCommandOutput: (commandId, data) =>
    set((state) => ({
      commandOutput: {
        ...state.commandOutput,
        [commandId]: (state.commandOutput[commandId] ?? '') + data,
      },
    })),

  markCommandExited: (commandId) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.commandId === commandId ? { ...t, alive: false } : t
      ),
    })),
}));
