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
  /** Port number for preview window feature */
  port?: number;
  /** Type of terminal: 'pty' for interactive shell, 'command' for non-interactive */
  type?: 'pty' | 'command';
}

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  panelVisible: boolean;
  /** Output buffer per commandId for server-managed commands */
  commandOutput: Record<string, string>;
  /** PTY data callbacks: ptyId -> callback function */
  ptyDataCallbacks: Record<string, (data: string) => void>;

  addTab: (tab: TerminalTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  markExited: (id: string) => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanel: () => void;
  appendCommandOutput: (commandId: string, data: string) => void;
  markCommandExited: (commandId: string) => void;
  registerPtyCallback: (ptyId: string, callback: (data: string) => void) => void;
  unregisterPtyCallback: (ptyId: string) => void;
  emitPtyData: (ptyId: string, data: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  panelVisible: false,
  commandOutput: {},
  ptyDataCallbacks: {},

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

  registerPtyCallback: (ptyId, callback) =>
    set((state) => ({
      ptyDataCallbacks: { ...state.ptyDataCallbacks, [ptyId]: callback },
    })),

  unregisterPtyCallback: (ptyId) =>
    set((state) => {
      const { [ptyId]: _, ...rest } = state.ptyDataCallbacks;
      return { ptyDataCallbacks: rest };
    }),

  emitPtyData: (ptyId, data) => {
    const callback = get().ptyDataCallbacks[ptyId];
    if (callback) {
      callback(data);
    }
  },
}));
