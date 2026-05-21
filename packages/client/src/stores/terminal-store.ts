import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { TerminalShell } from './settings-store';

/**
 * Synthetic project-id used for terminal tabs that belong to a scratch
 * thread (which has no real project). Tabs grouped under this id are
 * filtered/displayed exactly like project tabs — the runner derives the
 * actual cwd from `scratchThreadId` on the spawn payload, not from
 * `tab.cwd`.
 */
export const SCRATCH_TERMINAL_SCOPE_ID = '__scratch__';

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
  /** Timestamp when the tab was created */
  createdAt?: number;
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
  /** Command to auto-execute after the PTY shell is ready (startup commands) */
  initialCommand?: string;
  /** Scratch thread id when this tab is for a scratch (projectless) thread.
   * The runner uses this to derive the cwd as `~/.funny/scratch/<userId>/<threadId>`. */
  scratchThreadId?: string;
}

// Buffer for pty:data that arrives before a callback is registered.
// Stored outside Zustand to avoid re-renders on every data chunk.
// Accepts both string and Uint8Array — the hot path (PTY → server) now
// sends raw UTF-8 bytes as binary frames to skip JSON.stringify; the
// restore/adopt paths still send strings.
type PtyChunk = string | Uint8Array;
const pendingPtyData = new Map<string, PtyChunk[]>();

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** Per-project panel visibility (keyed by projectId) */
  panelVisibleByProject: Record<string, boolean>;
  /** Output buffer per commandId for server-managed commands */
  commandOutput: Record<string, string>;
  /** PTY data callbacks: ptyId -> callback function */
  ptyDataCallbacks: Record<string, (data: PtyChunk) => void>;
  /** Whether the server's pty:sessions response has been processed after WS connect */
  sessionsChecked: boolean;

  addTab: (tab: TerminalTab) => void;
  removeTab: (id: string) => void;
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  renameTab: (id: string, label: string) => void;
  setActiveTab: (id: string) => void;
  markExited: (id: string) => void;
  markAlive: (id: string) => void;
  respawnTab: (id: string) => void;
  setPanelVisible: (projectId: string, visible: boolean) => void;
  togglePanel: (projectId: string) => void;
  appendCommandOutput: (commandId: string, data: string) => void;
  markCommandExited: (commandId: string) => void;
  setTabError: (ptyId: string, error: string) => void;
  registerPtyCallback: (ptyId: string, callback: (data: PtyChunk) => void) => void;
  unregisterPtyCallback: (ptyId: string) => void;
  emitPtyData: (ptyId: string, data: PtyChunk) => void;
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
      panelVisibleByProject: {},
      commandOutput: {},
      commandMetrics: {},
      ptyDataCallbacks: {},
      sessionsChecked: false,

      addTab: (tab) =>
        set((state) => ({
          tabs: [...state.tabs, { ...tab, createdAt: tab.createdAt ?? Date.now() }],
          activeTabId: tab.id,
          panelVisibleByProject: {
            ...state.panelVisibleByProject,
            [tab.projectId]: true,
          },
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
          // Hide panel for this project if no more tabs remain for it
          const panelVisibleByProject = { ...state.panelVisibleByProject };
          const projectId = tab?.projectId;
          if (projectId && !remaining.some((t) => t.projectId === projectId)) {
            panelVisibleByProject[projectId] = false;
          }
          return {
            tabs: remaining,
            activeTabId,
            panelVisibleByProject,
            commandOutput,
          };
        }),

      reorderTabs: (projectId, fromIndex, toIndex) =>
        set((state) => {
          if (fromIndex === toIndex) return state;
          // Build the indices of this project's tabs within the global tabs array
          const projectTabIndices = state.tabs
            .map((t, i) => (t.projectId === projectId ? i : -1))
            .filter((i) => i !== -1);
          if (
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= projectTabIndices.length ||
            toIndex >= projectTabIndices.length
          ) {
            return state;
          }
          const projectTabs = projectTabIndices.map((i) => state.tabs[i]);
          const [moved] = projectTabs.splice(fromIndex, 1);
          projectTabs.splice(toIndex, 0, moved);
          // Splice the reordered project tabs back into the global array,
          // preserving the positions of tabs from other projects.
          const next = [...state.tabs];
          projectTabIndices.forEach((globalIdx, k) => {
            next[globalIdx] = projectTabs[k];
          });
          return { tabs: next };
        }),

      renameTab: (id, label) =>
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, label } : t)),
        })),

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

      setPanelVisible: (projectId, visible) =>
        set((state) => ({
          panelVisibleByProject: {
            ...state.panelVisibleByProject,
            [projectId]: visible,
          },
        })),

      togglePanel: (projectId) =>
        set((state) => ({
          panelVisibleByProject: {
            ...state.panelVisibleByProject,
            [projectId]: !(state.panelVisibleByProject[projectId] ?? false),
          },
        })),

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
        // (e.g. pty:restore response arriving while xterm was still loading).
        // Replay each chunk individually — buffered chunks are a mix of
        // strings (restore/adopt) and Uint8Arrays (hot path binary frames);
        // Array.join() would stringify Uint8Arrays as "1,2,3,…" and corrupt
        // the stream, so we hand each chunk to the callback as-is.
        const buffered = pendingPtyData.get(ptyId);
        if (buffered && buffered.length > 0) {
          pendingPtyData.delete(ptyId);
          // Replay in a microtask so the callback is set in state first
          queueMicrotask(() => {
            for (const chunk of buffered) callback(chunk);
          });
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
        // Socket.IO may surface binary attachments as ArrayBuffer; xterm only
        // accepts string | Uint8Array, so normalize once here at the boundary
        // instead of at every write site.
        const normalized: PtyChunk =
          data instanceof ArrayBuffer ? new Uint8Array(data) : (data as PtyChunk);
        const callback = get().ptyDataCallbacks[ptyId];
        if (callback) {
          callback(normalized);
        } else {
          // Buffer data until the xterm callback is registered.
          // This happens when pty:restore response arrives before the
          // terminal component has finished mounting.
          let buf = pendingPtyData.get(ptyId);
          if (!buf) {
            buf = [];
            pendingPtyData.set(ptyId, buf);
          }
          buf.push(normalized);
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

          // Only show panels for projects with new tabs that don't already
          // have an explicit visibility setting (respects user's previous close)
          const panelVisibleByProject = { ...state.panelVisibleByProject };
          for (const tab of newTabs) {
            if (tab.projectId && panelVisibleByProject[tab.projectId] === undefined) {
              panelVisibleByProject[tab.projectId] = true;
            }
          }

          return {
            tabs: [...tabs, ...newTabs],
            panelVisibleByProject,
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
        tabs: state.tabs.map((t) => ({
          ...t,
          alive: false,
          restored: false,
          error: undefined,
          initialCommand: undefined,
        })),
        activeTabId: state.activeTabId,
        panelVisibleByProject: state.panelVisibleByProject,
      }),
    },
  ),
);
