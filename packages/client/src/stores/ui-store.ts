import { create, type StoreApi } from 'zustand';

import { readProject } from '@/data/projects/read';
import {
  type RightPanelId,
  type ToolPanelId,
  findToolPanel,
  isRightToolPanelId,
} from '@/lib/tool-panels/registry';

import { useProjectStore } from './project-store';
import {
  clearThreadSelection,
  invalidateSelectThread,
  setThreadSelectListener,
} from './thread-store-internals';

const REVIEW_PANE_WIDTH_KEY = 'review_pane_width';
const DEFAULT_REVIEW_PANE_WIDTH = 28; // percentage of viewport width
const MIN_REVIEW_PANE_WIDTH = 20;
const MAX_REVIEW_PANE_WIDTH = 70;
const TIMELINE_VISIBLE_KEY = 'timeline_visible';
/** Pre-`tool-panels` keys, read once to seed {@link OPEN_RIGHT_PANEL_KEY}. */
const LEGACY_RIGHT_PANE_OPEN_KEY = 'right_pane_open';
const LEGACY_RIGHT_PANE_TAB_KEY = 'right_pane_tab';
/** The panel open on the right, or {@link NO_PANEL}. One key per location. */
const OPEN_RIGHT_PANEL_KEY = 'tool_panels.open.right';
const NO_PANEL = 'none';
const REVIEW_SUB_TAB_KEY = 'review_sub_tab';
const GRID_SELECTED_THREAD_KEY = 'funny:grid-selected-thread:v1';

/** The tool panel open in each location (openspec `tool-panels`); absent = closed. */
export interface OpenPanels {
  right?: RightPanelId;
}
export type ReviewSubTab = 'changes' | 'graph' | 'stash' | 'prs' | 'ci' | 'issues' | 'worktrees';
const VALID_REVIEW_SUB_TABS: ReviewSubTab[] = [
  'changes',
  'graph',
  'stash',
  'worktrees',
  'prs',
  'ci',
  'issues',
];

/** No stored state: the right pane opens on Activity, as before `tool-panels`. */
const DEFAULT_OPEN_PANELS: OpenPanels = { right: 'activity' };

/** The open panels stored on this device. Exported for tests. */
export function readOpenPanels(): OpenPanels {
  try {
    const stored = localStorage.getItem(OPEN_RIGHT_PANEL_KEY);
    if (stored !== null) return isRightToolPanelId(stored) ? { right: stored } : {};
    // Seed once from the keys written before `tool-panels`.
    const legacyOpen = localStorage.getItem(LEGACY_RIGHT_PANE_OPEN_KEY);
    if (legacyOpen === null) return DEFAULT_OPEN_PANELS;
    if (legacyOpen !== 'true') return {};
    const legacyTab = localStorage.getItem(LEGACY_RIGHT_PANE_TAB_KEY);
    return { right: isRightToolPanelId(legacyTab) ? legacyTab : 'activity' };
  } catch {
    return DEFAULT_OPEN_PANELS;
  }
}

function persistOpenPanels(openPanels: OpenPanels) {
  try {
    localStorage.setItem(OPEN_RIGHT_PANEL_KEY, openPanels.right ?? NO_PANEL);
  } catch {}
}

/** `openPanels` with the right location closed. */
function withRightClosed(openPanels: OpenPanels): OpenPanels {
  return openPanels.right === undefined ? openPanels : { ...openPanels, right: undefined };
}

/** Whether a panel is open on the right. */
export const selectRightPaneOpen = (s: { openPanels: OpenPanels }) =>
  s.openPanels.right !== undefined;

/** The panel open on the right, if any. */
export const selectRightPanel = (s: { openPanels: OpenPanels }) => s.openPanels.right;

/** Whether this panel is the one open in its location. */
export const selectPanelOpen = (id: ToolPanelId) => (s: { openPanels: OpenPanels }) =>
  s.openPanels.right === id;

function clearSelectedThread() {
  invalidateSelectThread();
  clearThreadSelection();
}

interface UIState {
  /** The tool panel open in each location. Change it only through the panel actions. */
  openPanels: OpenPanels;
  reviewPaneWidth: number; // percentage of viewport width
  reviewPaneResizing: boolean;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  /** Path the user came from before entering Settings — restored on back-arrow click. */
  settingsReturnPath: string | null;
  newThreadProjectId: string | null;
  newThreadIdleOnly: boolean;
  /** Branch preselected when opening the next normal new-thread compose. */
  newThreadBaseBranch: string | null;
  /** True when the user is composing a scratch (projectless) thread. */
  newThreadIsScratch: boolean;
  /**
   * Bumped on every startNewThread / startNewScratchThread. ThreadView keys the
   * compose form on it so a new-thread request always opens a fresh form, even
   * when the URL does not change (e.g. Alt+N while "Preparing…" is showing).
   */
  newThreadComposeId: number;
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  /**
   * The thread currently selected in the grid view (`LiveColumnsView`). The
   * grid's consolidated header action bar and the global right pane act on this
   * thread while the grid is open. Persisted to localStorage so it survives a
   * reload; falls back to auto-select-first when the stored id is no longer
   * placed in the grid. Null when the grid is empty / nothing selected.
   */
  gridSelectedThreadId: string | null;
  testRunnerOpen: boolean;
  designViewProjectId: string | null;
  designViewDesignId: string | null;
  /** Active design context for thread creation — when set, new threads are linked to this design. */
  activeDesignId: string | null;
  designsListProjectId: string | null;
  generalSettingsOpen: boolean;
  activePreferencesPage: string | null;
  timelineVisible: boolean;
  reviewSubTab: ReviewSubTab;
  kanbanContext: {
    projectId?: string;
    search?: string;
    caseSensitive?: boolean;
    threadId?: string;
    viewMode?: 'board' | 'list';
    /** The list's query string (every filter), restored by the thread's back button. */
    listQuery?: string;
  } | null;
  /**
   * Search handoff from a list/board view into the thread view: when the user
   * clicks a search result, the thread view opens its in-thread search bar
   * pre-filled with this query. Consumed (cleared) by ThreadSearchBar.
   */
  pendingThreadSearch: { threadId: string; query: string; caseSensitive: boolean } | null;
  /** Pre-fill context for creating a thread from a GitHub issue */
  newThreadIssueContext: { prompt: string; branchName: string; title: string } | null;
  /** Pre-fill prompt for compose mode coming from external sources (e.g. Tauri annotator). */
  composePrefillPrompt: string | null;
  commandPaletteOpen: boolean;
  fileSearchOpen: boolean;
  textSearchOpen: boolean;
  /**
   * Last text-search query and options, persisted across dialog open/close so
   * the user keeps their workspace when they pop the dialog to peek at a file
   * and then reopen it. Wiped only on explicit reset or sign-out.
   */
  textSearchState: {
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
    include: string;
    exclude: string;
  };
  keyboardShortcutsOpen: boolean;
  /**
   * Controlled open state for the header's Share-thread dialog. Lifted out of
   * the button so the Alt+H global shortcut can toggle it. Auto-reset to false
   * when the active thread changes (the dialog only mounts on owned threads).
   */
  shareDialogOpen: boolean;
  setShareDialogOpen: (open: boolean) => void;
  toggleShareDialog: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setFileSearchOpen: (open: boolean) => void;
  setTextSearchOpen: (open: boolean) => void;
  setTextSearchState: (patch: Partial<UIState['textSearchState']>) => void;
  setKeyboardShortcutsOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  toggleFileSearch: () => void;
  toggleTextSearch: () => void;
  toggleKeyboardShortcuts: () => void;
  setReviewSubTab: (tab: ReviewSubTab) => void;
  /** Open a tool panel, replacing the panel open in its location. */
  openPanel: (id: ToolPanelId) => void;
  /** Close the panel open on the right. */
  closeRightPanel: () => void;
  /** Close the panel if it is the one open in its location, open it otherwise. */
  togglePanel: (id: ToolPanelId) => void;
  setTestRunnerOpen: (open: boolean) => void;
  setReviewPaneWidth: (width: number) => void;
  setReviewPaneResizing: (resizing: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
  setSettingsReturnPath: (path: string | null) => void;
  setGeneralSettingsOpen: (open: boolean) => void;
  setActivePreferencesPage: (page: string | null) => void;
  startNewThread: (projectId: string, idleOnly?: boolean, baseBranch?: string | null) => void;
  /** Open the compose form in scratch mode (no project, no git). */
  startNewScratchThread: () => void;
  cancelNewThread: () => void;
  closeAllThreads: () => void;
  setAutomationInboxOpen: (open: boolean) => void;
  setAddProjectOpen: (open: boolean) => void;
  showGlobalSearch: () => void;
  setAnalyticsOpen: (open: boolean) => void;
  setLiveColumnsOpen: (open: boolean) => void;
  setDesignView: (projectId: string, designId: string) => void;
  closeDesignView: () => void;
  setActiveDesignId: (designId: string | null) => void;
  setDesignsListOpen: (projectId: string) => void;
  closeDesignsList: () => void;
  setTimelineVisible: (visible: boolean) => void;
  setGridSelectedThreadId: (threadId: string | null) => void;
  setKanbanContext: (
    context: {
      projectId?: string;
      search?: string;
      caseSensitive?: boolean;
      threadId?: string;
      viewMode?: 'board' | 'list';
      listQuery?: string;
    } | null,
  ) => void;
  setPendingThreadSearch: (
    pending: { threadId: string; query: string; caseSensitive: boolean } | null,
  ) => void;
  startNewThreadFromIssue: (
    projectId: string,
    issueContext: { prompt: string; branchName: string; title: string },
  ) => void;
  clearIssueContext: () => void;
  /** Set the prefill prompt used by the next compose mount (cleared after pickup). */
  setComposePrefillPrompt: (prompt: string | null) => void;
  /**
   * Dismissed thread recap cards (openspec thread-recap), keyed
   * `threadId:newestMessageId`: a recap for a newer message shows again.
   */
  dismissedRecaps: Record<string, true>;
  dismissRecap: (key: string) => void;
  /**
   * The thread open the one-time "utility model unavailable" hint was shown
   * for this session (`threadId:openedAt`); null until it is shown.
   */
  recapHintOpenKey: string | null;
  claimRecapHint: (openKey: string) => void;
}

type SetUIState = StoreApi<UIState>['setState'];
type GetUIState = StoreApi<UIState>['getState'];

/** Initial UI state, with the persisted panes read from localStorage. */
function readInitialUIState() {
  return {
    openPanels: readOpenPanels(),
    reviewPaneWidth: (() => {
      try {
        const stored = localStorage.getItem(REVIEW_PANE_WIDTH_KEY);
        return stored ? Number(stored) : DEFAULT_REVIEW_PANE_WIDTH;
      } catch {
        return DEFAULT_REVIEW_PANE_WIDTH;
      }
    })(),
    reviewPaneResizing: false,
    settingsOpen: false,
    activeSettingsPage: null,
    settingsReturnPath: null,
    newThreadProjectId: null,
    newThreadIdleOnly: false,
    newThreadBaseBranch: null,
    newThreadIsScratch: false,
    newThreadComposeId: 0,
    allThreadsProjectId: null,
    automationInboxOpen: false,
    addProjectOpen: false,
    analyticsOpen: false,
    liveColumnsOpen: false,
    gridSelectedThreadId: (() => {
      try {
        const stored = localStorage.getItem(GRID_SELECTED_THREAD_KEY);
        return stored && stored.length > 0 ? stored : null;
      } catch {
        return null;
      }
    })(),
    testRunnerOpen: false,
    designViewProjectId: null,
    designViewDesignId: null,
    activeDesignId: null,
    designsListProjectId: null,
    generalSettingsOpen: false,
    activePreferencesPage: null,
    timelineVisible: (() => {
      try {
        const stored = localStorage.getItem(TIMELINE_VISIBLE_KEY);
        return stored !== null ? stored === 'true' : false;
      } catch {
        return false;
      }
    })(),
    reviewSubTab: ((): ReviewSubTab => {
      try {
        const stored = localStorage.getItem(REVIEW_SUB_TAB_KEY);
        const match = VALID_REVIEW_SUB_TABS.find((tab) => tab === stored);
        if (match) return match;
      } catch {}
      return 'changes';
    })(),
    kanbanContext: null,
    pendingThreadSearch: null,
    newThreadIssueContext: null,
    composePrefillPrompt: null,
    commandPaletteOpen: false,
    fileSearchOpen: false,
    textSearchOpen: false,
    textSearchState: {
      query: '',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      include: '',
      exclude: '',
    },
    keyboardShortcutsOpen: false,
    shareDialogOpen: false,
  } satisfies Partial<UIState>;
}

/** Share dialog and the mutually exclusive search / palette overlays. */
function overlayActions(set: SetUIState) {
  return {
    setShareDialogOpen: (open) => set({ shareDialogOpen: open }),
    toggleShareDialog: () => set((s) => ({ shareDialogOpen: !s.shareDialogOpen })),
    setCommandPaletteOpen: (open) =>
      set(
        open
          ? {
              commandPaletteOpen: true,
              fileSearchOpen: false,
              textSearchOpen: false,
              keyboardShortcutsOpen: false,
            }
          : { commandPaletteOpen: false },
      ),
    setFileSearchOpen: (open) =>
      set(
        open
          ? {
              fileSearchOpen: true,
              commandPaletteOpen: false,
              textSearchOpen: false,
              keyboardShortcutsOpen: false,
            }
          : { fileSearchOpen: false },
      ),
    setTextSearchOpen: (open) =>
      set(
        open
          ? {
              textSearchOpen: true,
              commandPaletteOpen: false,
              fileSearchOpen: false,
              keyboardShortcutsOpen: false,
            }
          : { textSearchOpen: false },
      ),
    setTextSearchState: (patch) =>
      set((s) => ({ textSearchState: { ...s.textSearchState, ...patch } })),
    setKeyboardShortcutsOpen: (open) =>
      set(
        open
          ? {
              keyboardShortcutsOpen: true,
              commandPaletteOpen: false,
              fileSearchOpen: false,
              textSearchOpen: false,
            }
          : { keyboardShortcutsOpen: false },
      ),
    toggleCommandPalette: () =>
      set((s) =>
        s.commandPaletteOpen
          ? { commandPaletteOpen: false }
          : {
              commandPaletteOpen: true,
              fileSearchOpen: false,
              textSearchOpen: false,
              keyboardShortcutsOpen: false,
            },
      ),
    toggleFileSearch: () =>
      set((s) =>
        s.fileSearchOpen
          ? { fileSearchOpen: false }
          : {
              fileSearchOpen: true,
              commandPaletteOpen: false,
              textSearchOpen: false,
              keyboardShortcutsOpen: false,
            },
      ),
    toggleTextSearch: () =>
      set((s) =>
        s.textSearchOpen
          ? { textSearchOpen: false }
          : {
              textSearchOpen: true,
              commandPaletteOpen: false,
              fileSearchOpen: false,
              keyboardShortcutsOpen: false,
            },
      ),
    toggleKeyboardShortcuts: () =>
      set((s) =>
        s.keyboardShortcutsOpen
          ? { keyboardShortcutsOpen: false }
          : {
              keyboardShortcutsOpen: true,
              commandPaletteOpen: false,
              fileSearchOpen: false,
              textSearchOpen: false,
            },
      ),
  } satisfies Partial<UIState>;
}

/** Tool panels (openspec `tool-panels`) and the right pane's persisted layout. */
function rightPaneActions(set: SetUIState, get: GetUIState) {
  return {
    setReviewSubTab: (tab) => {
      try {
        localStorage.setItem(REVIEW_SUB_TAB_KEY, tab);
      } catch {}
      set({ reviewSubTab: tab });
    },
    openPanel: (id) => {
      const panel = findToolPanel(id);
      if (!panel) return;
      set((s) => ({ openPanels: { ...s.openPanels, [panel.location]: id } }));
    },
    closeRightPanel: () => set((s) => ({ openPanels: withRightClosed(s.openPanels) })),
    togglePanel: (id) => {
      const panel = findToolPanel(id);
      if (!panel) return;
      set((s) => ({
        openPanels: {
          ...s.openPanels,
          [panel.location]: s.openPanels[panel.location] === id ? undefined : id,
        },
      }));
    },
    setTestRunnerOpen: (open) => {
      if (open) {
        clearSelectedThread();
      }
      set(
        open
          ? {
              testRunnerOpen: true,
              openPanels: withRightClosed(get().openPanels),
              settingsOpen: false,
              activeSettingsPage: null,
              allThreadsProjectId: null,
              addProjectOpen: false,
              automationInboxOpen: false,
              analyticsOpen: false,
              liveColumnsOpen: false,
              generalSettingsOpen: false,
            }
          : { testRunnerOpen: false },
      );
    },
    setReviewPaneWidth: (width) => {
      const clamped = Math.max(MIN_REVIEW_PANE_WIDTH, Math.min(MAX_REVIEW_PANE_WIDTH, width));
      try {
        localStorage.setItem(REVIEW_PANE_WIDTH_KEY, String(clamped));
      } catch {}
      set({ reviewPaneWidth: clamped });
    },
    setReviewPaneResizing: (resizing) => set({ reviewPaneResizing: resizing }),
  } satisfies Partial<UIState>;
}

/** Full-page views: settings, automations, new thread compose, search, analytics. */
function navigationActions(set: SetUIState, get: GetUIState) {
  return {
    setSettingsOpen: (open) =>
      set(
        open
          ? {
              settingsOpen: true,
              generalSettingsOpen: false,
              activePreferencesPage: null,
              automationInboxOpen: false,
              addProjectOpen: false,
              testRunnerOpen: false,
            }
          : { settingsOpen: false, activeSettingsPage: null, settingsReturnPath: null },
      ),
    setActiveSettingsPage: (page) => set({ activeSettingsPage: page }),
    setSettingsReturnPath: (path) => set({ settingsReturnPath: path }),
    setGeneralSettingsOpen: (open) => {
      set(
        open
          ? {
              generalSettingsOpen: true,
              settingsOpen: false,
              activeSettingsPage: null,
              openPanels: withRightClosed(get().openPanels),
              automationInboxOpen: false,
              addProjectOpen: false,
              allThreadsProjectId: null,
              analyticsOpen: false,
              liveColumnsOpen: false,
              testRunnerOpen: false,
            }
          : { generalSettingsOpen: false, activePreferencesPage: null, settingsReturnPath: null },
      );
    },
    setActivePreferencesPage: (page) => set({ activePreferencesPage: page }),
    setAutomationInboxOpen: (open) => {
      if (open) {
        clearSelectedThread();
      }
      set(
        open
          ? {
              automationInboxOpen: true,
              openPanels: withRightClosed(get().openPanels),
              settingsOpen: false,
              activeSettingsPage: null,
              allThreadsProjectId: null,
              addProjectOpen: false,
              testRunnerOpen: false,
            }
          : { automationInboxOpen: false },
      );
    },

    setAddProjectOpen: (open) => {
      if (open) {
        clearSelectedThread();
        set({
          addProjectOpen: true,
          settingsOpen: false,
          automationInboxOpen: false,
          allThreadsProjectId: null,
          newThreadProjectId: null,
          newThreadBaseBranch: null,
          testRunnerOpen: false,
        });
      } else {
        set({ addProjectOpen: false });
      }
    },

    startNewThread: (projectId: string, idleOnly?: boolean, baseBranch?: string | null) => {
      // Block thread creation on shared projects that haven't been set up yet
      const project = readProject(projectId);
      if (project?.needsSetup) return;

      // Set the compose flag BEFORE clearing thread selection — the invariant
      // guard subscribes to thread-store changes and would otherwise re-select
      // the previous thread (from a stale URL) before the flag is visible to it.
      set((s) => ({
        newThreadComposeId: s.newThreadComposeId + 1,
        newThreadProjectId: projectId,
        newThreadIdleOnly: idleOnly ?? false,
        newThreadBaseBranch: baseBranch ?? null,
        newThreadIsScratch: false,
        allThreadsProjectId: null,
        automationInboxOpen: false,
        addProjectOpen: false,
        openPanels: withRightClosed(get().openPanels),
        testRunnerOpen: false,
      }));
      clearSelectedThread();
      useProjectStore.getState().selectProject(projectId);
    },

    startNewScratchThread: () => {
      // Set the compose flag BEFORE clearing thread selection — see note in
      // startNewThread above for why order matters.
      set((s) => ({
        newThreadComposeId: s.newThreadComposeId + 1,
        newThreadProjectId: null,
        newThreadIdleOnly: false,
        newThreadBaseBranch: null,
        newThreadIsScratch: true,
        allThreadsProjectId: null,
        automationInboxOpen: false,
        addProjectOpen: false,
        openPanels: withRightClosed(get().openPanels),
        testRunnerOpen: false,
      }));
      clearSelectedThread();
      useProjectStore.getState().selectProject(null);
    },

    cancelNewThread: () => {
      set({
        newThreadProjectId: null,
        newThreadIdleOnly: false,
        newThreadBaseBranch: null,
        newThreadIsScratch: false,
        newThreadIssueContext: null,
      });
    },

    closeAllThreads: () => {
      set({ allThreadsProjectId: null });
    },

    showGlobalSearch: () => {
      clearSelectedThread();
      set({
        allThreadsProjectId: '__all__',
        newThreadProjectId: null,
        newThreadBaseBranch: null,
        automationInboxOpen: false,
        addProjectOpen: false,
        settingsOpen: false,
        analyticsOpen: false,
        liveColumnsOpen: false,
        openPanels: withRightClosed(get().openPanels),
        testRunnerOpen: false,
      });
    },

    setAnalyticsOpen: (open) => {
      if (open) {
        clearSelectedThread();
      }
      set(
        open
          ? {
              analyticsOpen: true,
              openPanels: withRightClosed(get().openPanels),
              settingsOpen: false,
              activeSettingsPage: null,
              allThreadsProjectId: null,
              addProjectOpen: false,
              automationInboxOpen: false,
              liveColumnsOpen: false,
              testRunnerOpen: false,
            }
          : { analyticsOpen: false },
      );
    },

    setLiveColumnsOpen: (open) => {
      if (open) {
        clearSelectedThread();
      }
      set(
        open
          ? {
              liveColumnsOpen: true,
              openPanels: withRightClosed(get().openPanels),
              settingsOpen: false,
              activeSettingsPage: null,
              allThreadsProjectId: null,
              addProjectOpen: false,
              automationInboxOpen: false,
              analyticsOpen: false,
              testRunnerOpen: false,
            }
          : { liveColumnsOpen: false },
      );
    },
  } satisfies Partial<UIState>;
}

/** Designs, timeline, grid selection, kanban handoff, compose prefill and recaps. */
function designAndMiscActions(set: SetUIState, get: GetUIState) {
  return {
    setDesignView: (projectId, designId) => {
      set({
        designViewProjectId: projectId,
        designViewDesignId: designId,
        activeDesignId: designId,
        settingsOpen: false,
        activeSettingsPage: null,
        generalSettingsOpen: false,
        activePreferencesPage: null,
        allThreadsProjectId: null,
        addProjectOpen: false,
        automationInboxOpen: false,
        analyticsOpen: false,
        liveColumnsOpen: false,
        testRunnerOpen: false,
      });
    },

    closeDesignView: () => {
      set({ designViewProjectId: null, designViewDesignId: null, activeDesignId: null });
    },

    setActiveDesignId: (designId) => set({ activeDesignId: designId }),

    setDesignsListOpen: (projectId) => {
      clearSelectedThread();
      set({
        designsListProjectId: projectId,
        designViewProjectId: null,
        designViewDesignId: null,
        activeDesignId: null,
        openPanels: withRightClosed(get().openPanels),
        settingsOpen: false,
        activeSettingsPage: null,
        generalSettingsOpen: false,
        activePreferencesPage: null,
        allThreadsProjectId: null,
        addProjectOpen: false,
        automationInboxOpen: false,
        analyticsOpen: false,
        liveColumnsOpen: false,
        testRunnerOpen: false,
      });
    },

    closeDesignsList: () => {
      set({ designsListProjectId: null });
    },

    setTimelineVisible: (visible) => {
      try {
        localStorage.setItem(TIMELINE_VISIBLE_KEY, String(visible));
      } catch {}
      set({ timelineVisible: visible });
    },
    setGridSelectedThreadId: (threadId) => {
      try {
        if (threadId) {
          localStorage.setItem(GRID_SELECTED_THREAD_KEY, threadId);
        } else {
          localStorage.removeItem(GRID_SELECTED_THREAD_KEY);
        }
      } catch {}
      set({ gridSelectedThreadId: threadId });
    },
    setKanbanContext: (context) =>
      set(() => {
        // Card-click handoff: every list/board result click routes through here
        // with the active search + target thread. Derive the in-thread search
        // seed so the thread view can reopen the query with highlights. A
        // thread click without a search clears any stale seed.
        if (context?.threadId) {
          const query = context.search?.trim();
          return {
            kanbanContext: context,
            pendingThreadSearch: query
              ? {
                  threadId: context.threadId,
                  query,
                  caseSensitive: context.caseSensitive ?? false,
                }
              : null,
          };
        }
        return { kanbanContext: context };
      }),

    setPendingThreadSearch: (pending) => set({ pendingThreadSearch: pending }),

    startNewThreadFromIssue: (projectId, issueContext) => {
      // Reuse startNewThread logic but also set the issue context
      const { startNewThread } = useUIStore.getState();
      set({ newThreadIssueContext: issueContext });
      startNewThread(projectId);
    },

    clearIssueContext: () => set({ newThreadIssueContext: null }),

    setComposePrefillPrompt: (prompt) => set({ composePrefillPrompt: prompt }),

    dismissedRecaps: {},
    dismissRecap: (key) =>
      set((s) =>
        s.dismissedRecaps[key] ? s : { dismissedRecaps: { ...s.dismissedRecaps, [key]: true } },
      ),

    recapHintOpenKey: null,
    claimRecapHint: (openKey) =>
      set((s) => (s.recapHintOpenKey === null ? { recapHintOpenKey: openKey } : s)),
  } satisfies Partial<UIState>;
}

export const useUIStore = create<UIState>((set, get) => ({
  ...readInitialUIState(),
  ...overlayActions(set),
  ...rightPaneActions(set, get),
  ...navigationActions(set, get),
  ...designAndMiscActions(set, get),
}));

// Every write of `openPanels` is remembered on the device, whoever made it.
useUIStore.subscribe((state, prev) => {
  if (state.openPanels !== prev.openPanels) persistOpenPanels(state.openPanels);
});

// Reset transient UI panes whenever a thread is selected.
// Registered via the listener API to avoid a thread-store ↔ ui-store import cycle.
setThreadSelectListener((threadId) => {
  const uiPatch: Partial<UIState> = {
    newThreadProjectId: null,
    newThreadBaseBranch: null,
    allThreadsProjectId: null,
  };
  if (threadId) {
    uiPatch.newThreadIsScratch = false;
    uiPatch.newThreadIdleOnly = false;
  }
  useUIStore.setState(uiPatch);
});
