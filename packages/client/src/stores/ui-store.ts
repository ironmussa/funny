import { create } from 'zustand';

import { useProjectStore } from './project-store';
import { useThreadStore, invalidateSelectThread } from './thread-store';
import { setThreadSelectListener } from './thread-store-internals';

const REVIEW_PANE_WIDTH_KEY = 'review_pane_width';
const DEFAULT_REVIEW_PANE_WIDTH = 50; // percentage of viewport width
const MIN_REVIEW_PANE_WIDTH = 20;
const MAX_REVIEW_PANE_WIDTH = 70;
const TIMELINE_VISIBLE_KEY = 'timeline_visible';
const RIGHT_PANE_OPEN_KEY = 'right_pane_open';
const RIGHT_PANE_TAB_KEY = 'right_pane_tab';
const REVIEW_SUB_TAB_KEY = 'review_sub_tab';

export type RightPaneTab = 'review' | 'activity' | 'files';
export type ReviewSubTab = 'changes' | 'history' | 'stash' | 'prs';
const VALID_REVIEW_SUB_TABS: ReviewSubTab[] = ['changes', 'history', 'stash', 'prs'];

function persistRightPane(open: boolean, tab?: RightPaneTab) {
  try {
    localStorage.setItem(RIGHT_PANE_OPEN_KEY, String(open));
    if (tab) localStorage.setItem(RIGHT_PANE_TAB_KEY, tab);
  } catch {}
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
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
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
    threadId?: string;
    viewMode?: 'board' | 'list';
  } | null;
  /** Pre-fill context for creating a thread from a GitHub issue */
  newThreadIssueContext: { prompt: string; branchName: string; title: string } | null;
  commandPaletteOpen: boolean;
  fileSearchOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  setFileSearchOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  toggleFileSearch: () => void;
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
  setKanbanContext: (
    context: {
      projectId?: string;
      search?: string;
      threadId?: string;
      viewMode?: 'board' | 'list';
    } | null,
  ) => void;
  startNewThreadFromIssue: (
    projectId: string,
    issueContext: { prompt: string; branchName: string; title: string },
  ) => void;
  clearIssueContext: () => void;
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
  allThreadsProjectId: null,
  automationInboxOpen: false,
  addProjectOpen: false,
  analyticsOpen: false,
  liveColumnsOpen: false,
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
  newThreadIssueContext: null,
  commandPaletteOpen: false,
  fileSearchOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setFileSearchOpen: (open) => set({ fileSearchOpen: open }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  toggleFileSearch: () => set((s) => ({ fileSearchOpen: !s.fileSearchOpen })),
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
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
            testRunnerOpen: false,
          }
        : { generalSettingsOpen: false, activePreferencesPage: null },
    );
  },
  setActivePreferencesPage: (page) => set({ activePreferencesPage: page }),
  setAutomationInboxOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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

    invalidateSelectThread();
    useProjectStore.getState().selectProject(projectId);
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    persistRightPane(false);
    set({
      newThreadProjectId: projectId,
      newThreadIdleOnly: idleOnly ?? false,
      allThreadsProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      reviewPaneOpen: false,
      testRunnerOpen: false,
    });
  },

  cancelNewThread: () => {
    set({ newThreadProjectId: null, newThreadIdleOnly: false, newThreadIssueContext: null });
  },

  closeAllThreads: () => {
    set({ allThreadsProjectId: null });
  },

  showGlobalSearch: () => {
    invalidateSelectThread();
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    persistRightPane(false);
    set({
      allThreadsProjectId: '__all__',
      newThreadProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      settingsOpen: false,
      analyticsOpen: false,
      liveColumnsOpen: false,
      reviewPaneOpen: false,
      testRunnerOpen: false,
    });
  },

  setAnalyticsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
            testRunnerOpen: false,
          }
        : { analyticsOpen: false },
    );
  },

  setLiveColumnsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
            testRunnerOpen: false,
          }
        : { liveColumnsOpen: false },
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
      testRunnerOpen: false,
    });
  },

  closeDesignView: () => {
    set({ designViewProjectId: null, designViewDesignId: null, activeDesignId: null });
  },

  setActiveDesignId: (designId) => set({ activeDesignId: designId }),

  setDesignsListOpen: (projectId) => {
    invalidateSelectThread();
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
  setKanbanContext: (context) => set({ kanbanContext: context }),

  startNewThreadFromIssue: (projectId, issueContext) => {
    // Reuse startNewThread logic but also set the issue context
    const { startNewThread } = useUIStore.getState();
    set({ newThreadIssueContext: issueContext });
    startNewThread(projectId);
  },

  clearIssueContext: () => set({ newThreadIssueContext: null }),
}));

// Reset transient UI panes whenever a thread is selected.
// Registered via the listener API to avoid a thread-store ↔ ui-store import cycle.
setThreadSelectListener(() => {
  useUIStore.setState({ newThreadProjectId: null, allThreadsProjectId: null });
});
