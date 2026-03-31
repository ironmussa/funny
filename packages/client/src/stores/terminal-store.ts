import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { TerminalShell } from './settings-store';

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
  /** Shell override for this terminal (e.g. 'git-bash', 'powershell') */
  shell?: TerminalShell;
  /** Error message if the PTY failed to spawn */
  error?: string;
  /** Tab was restored from a server-side persistent session (tmux) */
  restored?: boolean;
  /** True when a bell (\x07) was received while this tab was not active */
  hasBell?: boolean;
}

// Buffer for pty:data that arrives before a callback is registered.
// Stored outside Zustand to avoid re-renders on every data chunk.
const pendingPtyData = new Map<string, string[]>();

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  panelVisible: boolean;
  /** Output buffer per commandId for server-managed commands */
  commandOutput: Record<string, string>;
  /** PTY data callbacks: ptyId -> callback function */
  ptyDataCallbacks: Record<string, (data: string) => void>;
  /** Whether the server's pty:sessions response has been processed after WS connect */
  sessionsChecked: boolean;

  addTab: (tab: TerminalTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  markExited: (id: string) => void;
  markAlive: (id: string) => void;
  respawnTab: (id: string) => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanel: () => void;
  appendCommandOutput: (commandId: string, data: string) => void;
  markCommandExited: (commandId: string) => void;
  setTabError: (ptyId: string, error: string) => void;
  registerPtyCallback: (ptyId: string, callback: (data: string) => void) => void;
  unregisterPtyCallback: (ptyId: string) => void;
  emitPtyData: (ptyId: string, data: string) => void;
  setBellActive: (id: string) => void;
  clearBell: (id: string) => void;
  /** Metrics for running commands (uptime, memory, restart count) */
  commandMetrics: Record<string, { uptime: number; restartCount: number; memoryUsageKB: number }>;
  updateCommandMetrics: (data: {
    commandId: string;
    uptime: number;
    restartCount: number;
    memoryUsageKB: number;
  }) => void;
  markSessionsChecked: () => void;
  resetSessionsChecked: () => void;
  restoreTabs: (
    sessions: { ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }[],
    projects: { id: string; path: string }[],
  ) => void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      panelVisible: false,
      commandOutput: {},
      commandMetrics: {},
      ptyDataCallbacks: {},
      sessionsChecked: false,

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

      setActiveTab: (id) =>
        set((state) => ({
          activeTabId: id,
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, hasBell: false } : t)),
        })),

      markExited: (id) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, alive: false } : t)),
        })),

      markAlive: (id) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, alive: true, error: undefined } : t)),
        })),

      respawnTab: (id) =>
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, alive: true, error: undefined, restored: false } : t,
          ),
        })),

      setPanelVisible: (visible) => set({ panelVisible: visible }),

      togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),

      appendCommandOutput: (commandId, data) =>
        set((state) => ({
          commandOutput: {
            ...state.commandOutput,
            [commandId]: (state.commandOutput[commandId] ?? '') + data,
          },
        })),

      markCommandExited: (commandId) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.commandId === commandId ? { ...t, alive: false } : t)),
        })),

      setTabError: (ptyId, error) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === ptyId ? { ...t, error, alive: false } : t)),
        })),

      registerPtyCallback: (ptyId, callback) => {
        // Replay any data that arrived before the callback was registered
        // (e.g. pty:restore response arriving while xterm was still loading)
        const buffered = pendingPtyData.get(ptyId);
        if (buffered && buffered.length > 0) {
          const joined = buffered.join('');
          pendingPtyData.delete(ptyId);
          // Replay in a microtask so the callback is set in state first
          queueMicrotask(() => callback(joined));
        }
        set((state) => ({
          ptyDataCallbacks: { ...state.ptyDataCallbacks, [ptyId]: callback },
        }));
      },

      unregisterPtyCallback: (ptyId) => {
        pendingPtyData.delete(ptyId);
        set((state) => {
          const { [ptyId]: _, ...rest } = state.ptyDataCallbacks;
          return { ptyDataCallbacks: rest };
        });
      },

      emitPtyData: (ptyId, data) => {
        const callback = get().ptyDataCallbacks[ptyId];
        if (callback) {
          callback(data);
        } else {
          // Buffer data until the xterm callback is registered.
          // This happens when pty:restore response arrives before the
          // terminal component has finished mounting.
          let buf = pendingPtyData.get(ptyId);
          if (!buf) {
            buf = [];
            pendingPtyData.set(ptyId, buf);
          }
          buf.push(data);
        }
      },

      setBellActive: (id) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, hasBell: true } : t)),
        })),

      clearBell: (id) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, hasBell: false } : t)),
        })),

      updateCommandMetrics: (data) =>
        set((state) => ({
          commandMetrics: {
            ...state.commandMetrics,
            [data.commandId]: {
              uptime: data.uptime,
              restartCount: data.restartCount,
              memoryUsageKB: data.memoryUsageKB,
            },
          },
        })),

      markSessionsChecked: () => set({ sessionsChecked: true }),
      resetSessionsChecked: () => set({ sessionsChecked: false }),

      restoreTabs: (sessions, projects) =>
        set((state) => {
          const existingIds = new Set(state.tabs.map((t) => t.id));
          const newTabs: TerminalTab[] = [];
          const sessionIds = new Set(sessions.map((s) => s.ptyId));

          // 1. Mark existing tabs as alive if they are in the session list
          let tabs = state.tabs.map((t) => {
            if (sessionIds.has(t.id)) {
              const s = sessions.find((s) => s.ptyId === t.id)!;
              return {
                ...t,
                alive: true,
                restored: true,
                label: s.label ?? t.label,
                projectId: s.projectId ?? t.projectId,
              };
            }
            return t;
          });

          // 2. Add new tabs for sessions we don't know about yet
          for (const s of sessions) {
            if (existingIds.has(s.ptyId)) continue;
            const matchedProject = projects.find(
              (p) => s.projectId === p.id || s.cwd === p.path || s.cwd.startsWith(p.path + '/'),
            );
            newTabs.push({
              id: s.ptyId,
              label: s.label ?? `Terminal (restored)`,
              cwd: s.cwd,
              alive: true,
              projectId: s.projectId ?? matchedProject?.id ?? '',
              type: 'pty',
              shell: (s.shell as TerminalShell) ?? undefined,
              restored: true,
            });
          }

          if (newTabs.length === 0 && tabs === state.tabs) {
            // Even if no tab changes, mark sessionsChecked atomically
            return { sessionsChecked: true };
          }

          return {
            tabs: [...tabs, ...newTabs],
            panelVisible: newTabs.length > 0 ? true : state.panelVisible,
            activeTabId: state.activeTabId ?? newTabs[0]?.id ?? tabs[0]?.id ?? null,
            // Mark sessionsChecked atomically with the tab update — avoids
            // intermediate state flickers that cancel in-flight spawn timers.
            sessionsChecked: true,
          };
        }),
    }),
    {
      name: 'funny-terminal-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs.map((t) => ({ ...t, alive: false })), // Tabs are not "alive" until re-connected
        activeTabId: state.activeTabId,
        panelVisible: state.panelVisible,
      }),
    },
  ),
);
