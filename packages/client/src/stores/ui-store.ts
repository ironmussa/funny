import { create } from 'zustand';

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
const RIGHT_PANE_OPEN_KEY = 'right_pane_open';
const RIGHT_PANE_TAB_KEY = 'right_pane_tab';
const REVIEW_SUB_TAB_KEY = 'review_sub_tab';

export type RightPaneTab = 'review' | 'activity' | 'files';
export type ReviewSubTab = 'changes' | 'graph' | 'stash' | 'prs' | 'ci' | 'issues';
const VALID_REVIEW_SUB_TABS: ReviewSubTab[] = ['changes', 'graph', 'stash', 'prs', 'ci', 'issues'];

function persistRightPane(open: boolean, tab?: RightPaneTab) {
  try {
    localStorage.setItem(RIGHT_PANE_OPEN_KEY, String(open));
    if (tab) localStorage.setItem(RIGHT_PANE_TAB_KEY, tab);
  } catch {}
}

function clearSelectedThread() {
  invalidateSelectThread();
  clearThreadSelection();
}

interface UIState {
  reviewPaneOpen: boolean;
  reviewPaneWidth: number; // percentage of viewport width
  reviewPaneResizing: boolean;
  rightPaneTab: RightPaneTab;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  /** Path the user came from before entering Settings — restored on back-arrow click. */
  settingsReturnPath: string | null;
  newThreadProjectId: string | null;
  newThreadIdleOnly: boolean;
  /** True when the user is composing a scratch (projectless) thread. */
  newThreadIsScratch: boolean;
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  orchestratorOpen: boolean;
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
  setReviewPaneOpen: (open: boolean) => void;
  setTestRunnerOpen: (open: boolean) => void;
  setActivityPaneOpen: (open: boolean) => void;
  setFilesPaneOpen: (open: boolean) => void;
  setReviewPaneWidth: (width: number) => void;
  setReviewPaneResizing: (resizing: boolean) => void;
  setRightPaneTab: (tab: RightPaneTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
  setSettingsReturnPath: (path: string | null) => void;
  setGeneralSettingsOpen: (open: boolean) => void;
  setActivePreferencesPage: (page: string | null) => void;
  startNewThread: (projectId: string, idleOnly?: boolean) => void;
  /** Open the compose form in scratch mode (no project, no git). */
  startNewScratchThread: () => void;
  cancelNewThread: () => void;
  closeAllThreads: () => void;
  setAutomationInboxOpen: (open: boolean) => void;
  setAddProjectOpen: (open: boolean) => void;
  showGlobalSearch: () => void;
  setAnalyticsOpen: (open: boolean) => void;
  setLiveColumnsOpen: (open: boolean) => void;
  setOrchestratorOpen: (open: boolean) => void;
  setDesignView: (projectId: string, designId: string) => void;
  closeDesignView: () => void;
  setActiveDesignId: (designId: string | null) => void;
  setDesignsListOpen: (projectId: string) => void;
  closeDesignsList: () => void;
  setTimelineVisible: (visible: boolean) => void;
  setKanbanContext: (
    context: {
      projectId?: string;
      search?: string;
      caseSensitive?: boolean;
      threadId?: string;
      viewMode?: 'board' | 'list';
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
}

export const useUIStore = create<UIState>((set) => ({
  reviewPaneOpen: (() => {
    try {
      const stored = localStorage.getItem(RIGHT_PANE_OPEN_KEY);
      if (stored !== null) return stored === 'true';
      return true;
    } catch {
      return true;
    }
  })(),
  rightPaneTab: (() => {
    try {
      const stored = localStorage.getItem(RIGHT_PANE_TAB_KEY);
      if (stored && ['review', 'activity', 'files'].includes(stored)) {
        return stored as RightPaneTab;
      }
      return 'activity' as RightPaneTab;
    } catch {
      return 'activity' as RightPaneTab;
    }
  })(),
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
  newThreadIsScratch: false,
  allThreadsProjectId: null,
  automationInboxOpen: false,
  addProjectOpen: false,
  analyticsOpen: false,
  liveColumnsOpen: false,
  orchestratorOpen: false,
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
  reviewSubTab: (() => {
    try {
      const stored = localStorage.getItem(REVIEW_SUB_TAB_KEY);
      if (stored && VALID_REVIEW_SUB_TABS.includes(stored as ReviewSubTab)) {
        return stored as ReviewSubTab;
      }
    } catch {}
    return 'changes' as ReviewSubTab;
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
  setReviewSubTab: (tab) => {
    try {
      localStorage.setItem(REVIEW_SUB_TAB_KEY, tab);
    } catch {}
    set({ reviewSubTab: tab });
  },
  setReviewPaneOpen: (open) => {
    persistRightPane(open, open ? 'review' : undefined);
    set(
      open
        ? { reviewPaneOpen: true, rightPaneTab: 'review' as RightPaneTab }
        : { reviewPaneOpen: false },
    );
  },
  setTestRunnerOpen: (open) => {
    if (open) {
      clearSelectedThread();
      persistRightPane(false);
    }
    set(
      open
        ? {
            testRunnerOpen: true,
            reviewPaneOpen: false,
            settingsOpen: false,
            activeSettingsPage: null,
            allThreadsProjectId: null,
            addProjectOpen: false,
            automationInboxOpen: false,
            analyticsOpen: false,
            liveColumnsOpen: false,
            orchestratorOpen: false,
            generalSettingsOpen: false,
          }
        : { testRunnerOpen: false },
    );
  },
  setActivityPaneOpen: (open) => {
    persistRightPane(open, open ? 'activity' : undefined);
    set(
      open
        ? { reviewPaneOpen: true, rightPaneTab: 'activity' as RightPaneTab }
        : { reviewPaneOpen: false },
    );
  },
  setFilesPaneOpen: (open) => {
    persistRightPane(open, open ? 'files' : undefined);
    set(
      open
        ? { reviewPaneOpen: true, rightPaneTab: 'files' as RightPaneTab }
        : { reviewPaneOpen: false },
    );
  },
  setRightPaneTab: (tab) => {
    persistRightPane(true, tab);
    set({ rightPaneTab: tab, reviewPaneOpen: true });
  },
  setReviewPaneWidth: (width) => {
    const clamped = Math.max(MIN_REVIEW_PANE_WIDTH, Math.min(MAX_REVIEW_PANE_WIDTH, width));
    try {
      localStorage.setItem(REVIEW_PANE_WIDTH_KEY, String(clamped));
    } catch {}
    set({ reviewPaneWidth: clamped });
  },
  setReviewPaneResizing: (resizing) => set({ reviewPaneResizing: resizing }),
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
    if (open) {
      persistRightPane(false);
    }
    set(
      open
        ? {
            generalSettingsOpen: true,
            settingsOpen: false,
            activeSettingsPage: null,
            reviewPaneOpen: false,
            automationInboxOpen: false,
            addProjectOpen: false,
            allThreadsProjectId: null,
            analyticsOpen: false,
            liveColumnsOpen: false,
            orchestratorOpen: false,
            testRunnerOpen: false,
          }
        : { generalSettingsOpen: false, activePreferencesPage: null, settingsReturnPath: null },
    );
  },
  setActivePreferencesPage: (page) => set({ activePreferencesPage: page }),
  setAutomationInboxOpen: (open) => {
    if (open) {
      clearSelectedThread();
      persistRightPane(false);
    }
    set(
      open
        ? {
            automationInboxOpen: true,
            reviewPaneOpen: false,
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
        testRunnerOpen: false,
      });
    } else {
      set({ addProjectOpen: false });
    }
  },

  startNewThread: (projectId: string, idleOnly?: boolean) => {
    // Block thread creation on shared projects that haven't been set up yet
    const project = useProjectStore.getState().projects?.find((p) => p.id === projectId);
    if (project?.needsSetup) return;

    // Set the compose flag BEFORE clearing thread selection — the invariant
    // guard subscribes to thread-store changes and would otherwise re-select
    // the previous thread (from a stale URL) before the flag is visible to it.
    set({
      newThreadProjectId: projectId,
      newThreadIdleOnly: idleOnly ?? false,
      newThreadIsScratch: false,
      allThreadsProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      reviewPaneOpen: false,
      testRunnerOpen: false,
    });
    clearSelectedThread();
    useProjectStore.getState().selectProject(projectId);
    persistRightPane(false);
  },

  startNewScratchThread: () => {
    // Set the compose flag BEFORE clearing thread selection — see note in
    // startNewThread above for why order matters.
    set({
      newThreadProjectId: null,
      newThreadIdleOnly: false,
      newThreadIsScratch: true,
      allThreadsProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      reviewPaneOpen: false,
      testRunnerOpen: false,
    });
    clearSelectedThread();
    useProjectStore.getState().selectProject(null);
    persistRightPane(false);
  },

  cancelNewThread: () => {
    set({
      newThreadProjectId: null,
      newThreadIdleOnly: false,
      newThreadIsScratch: false,
      newThreadIssueContext: null,
    });
  },

  closeAllThreads: () => {
    set({ allThreadsProjectId: null });
  },

  showGlobalSearch: () => {
    clearSelectedThread();
    persistRightPane(false);
    set({
      allThreadsProjectId: '__all__',
      newThreadProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      settingsOpen: false,
      analyticsOpen: false,
      liveColumnsOpen: false,
      orchestratorOpen: false,
      reviewPaneOpen: false,
      testRunnerOpen: false,
    });
  },

  setAnalyticsOpen: (open) => {
    if (open) {
      clearSelectedThread();
      persistRightPane(false);
    }
    set(
      open
        ? {
            analyticsOpen: true,
            reviewPaneOpen: false,
            settingsOpen: false,
            activeSettingsPage: null,
            allThreadsProjectId: null,
            addProjectOpen: false,
            automationInboxOpen: false,
            liveColumnsOpen: false,
            orchestratorOpen: false,
            testRunnerOpen: false,
          }
        : { analyticsOpen: false },
    );
  },

  setLiveColumnsOpen: (open) => {
    if (open) {
      clearSelectedThread();
      persistRightPane(false);
    }
    set(
      open
        ? {
            liveColumnsOpen: true,
            reviewPaneOpen: false,
            settingsOpen: false,
            activeSettingsPage: null,
            allThreadsProjectId: null,
            addProjectOpen: false,
            automationInboxOpen: false,
            analyticsOpen: false,
            orchestratorOpen: false,
            testRunnerOpen: false,
          }
        : { liveColumnsOpen: false },
    );
  },

  setOrchestratorOpen: (open) => {
    if (open) {
      clearSelectedThread();
      persistRightPane(false);
    }
    set(
      open
        ? {
            orchestratorOpen: true,
            reviewPaneOpen: false,
            settingsOpen: false,
            activeSettingsPage: null,
            allThreadsProjectId: null,
            addProjectOpen: false,
            automationInboxOpen: false,
            analyticsOpen: false,
            liveColumnsOpen: false,
            testRunnerOpen: false,
          }
        : { orchestratorOpen: false },
    );
  },

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
      orchestratorOpen: false,
      testRunnerOpen: false,
    });
  },

  closeDesignView: () => {
    set({ designViewProjectId: null, designViewDesignId: null, activeDesignId: null });
  },

  setActiveDesignId: (designId) => set({ activeDesignId: designId }),

  setDesignsListOpen: (projectId) => {
    clearSelectedThread();
    persistRightPane(false);
    set({
      designsListProjectId: projectId,
      designViewProjectId: null,
      designViewDesignId: null,
      activeDesignId: null,
      reviewPaneOpen: false,
      settingsOpen: false,
      activeSettingsPage: null,
      generalSettingsOpen: false,
      activePreferencesPage: null,
      allThreadsProjectId: null,
      addProjectOpen: false,
      automationInboxOpen: false,
      analyticsOpen: false,
      liveColumnsOpen: false,
      orchestratorOpen: false,
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
}));

// Reset transient UI panes whenever a thread is selected.
// Registered via the listener API to avoid a thread-store ↔ ui-store import cycle.
setThreadSelectListener(() => {
  useUIStore.setState({ newThreadProjectId: null, allThreadsProjectId: null });
});
