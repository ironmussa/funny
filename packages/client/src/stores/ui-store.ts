import { create } from 'zustand';

import { useProjectStore } from './project-store';
import { useThreadStore, invalidateSelectThread } from './thread-store';

const REVIEW_PANE_WIDTH_KEY = 'review_pane_width';
const DEFAULT_REVIEW_PANE_WIDTH = 50; // percentage of viewport width
const MIN_REVIEW_PANE_WIDTH = 20;
const MAX_REVIEW_PANE_WIDTH = 70;
const TIMELINE_VISIBLE_KEY = 'timeline_visible';

export type RightPaneTab = 'review' | 'tests';

interface UIState {
  reviewPaneOpen: boolean;
  reviewPaneWidth: number; // percentage of viewport width
  rightPaneTab: RightPaneTab;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  newThreadProjectId: string | null;
  newThreadIdleOnly: boolean;
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  generalSettingsOpen: boolean;
  activePreferencesPage: string | null;
  timelineVisible: boolean;
  kanbanContext: { projectId?: string; search?: string; threadId?: string } | null;
  setReviewPaneOpen: (open: boolean) => void;
  setReviewPaneWidth: (width: number) => void;
  setRightPaneTab: (tab: RightPaneTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
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
  setTimelineVisible: (visible: boolean) => void;
  setKanbanContext: (
    context: { projectId?: string; search?: string; threadId?: string } | null,
  ) => void;
}

export const useUIStore = create<UIState>((set) => ({
  reviewPaneOpen: false,
  rightPaneTab: 'review' as RightPaneTab,
  reviewPaneWidth: (() => {
    try {
      const stored = localStorage.getItem(REVIEW_PANE_WIDTH_KEY);
      return stored ? Number(stored) : DEFAULT_REVIEW_PANE_WIDTH;
    } catch {
      return DEFAULT_REVIEW_PANE_WIDTH;
    }
  })(),
  settingsOpen: false,
  activeSettingsPage: null,
  newThreadProjectId: null,
  newThreadIdleOnly: false,
  allThreadsProjectId: null,
  automationInboxOpen: false,
  addProjectOpen: false,
  analyticsOpen: false,
  liveColumnsOpen: false,
  generalSettingsOpen: false,
  activePreferencesPage: null,
  timelineVisible: (() => {
    try {
      const stored = localStorage.getItem(TIMELINE_VISIBLE_KEY);
      return stored !== null ? stored === 'true' : true;
    } catch {
      return true;
    }
  })(),
  kanbanContext: null,
  setReviewPaneOpen: (open) => set({ reviewPaneOpen: open }),
  setRightPaneTab: (tab) => set({ rightPaneTab: tab, reviewPaneOpen: true }),
  setReviewPaneWidth: (width) => {
    const clamped = Math.max(MIN_REVIEW_PANE_WIDTH, Math.min(MAX_REVIEW_PANE_WIDTH, width));
    try {
      localStorage.setItem(REVIEW_PANE_WIDTH_KEY, String(clamped));
    } catch {}
    set({ reviewPaneWidth: clamped });
  },
  setSettingsOpen: (open) =>
    set(
      open
        ? { settingsOpen: true, automationInboxOpen: false, addProjectOpen: false }
        : { settingsOpen: false, activeSettingsPage: null },
    ),
  setActiveSettingsPage: (page) => set({ activeSettingsPage: page }),
  setGeneralSettingsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
          }
        : { generalSettingsOpen: false, activePreferencesPage: null },
    );
  },
  setActivePreferencesPage: (page) => set({ activePreferencesPage: page }),
  setAutomationInboxOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
      });
    } else {
      set({ addProjectOpen: false });
    }
  },

  startNewThread: (projectId: string, idleOnly?: boolean) => {
    // Block thread creation on shared projects that haven't been set up yet
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (project?.needsSetup) return;

    invalidateSelectThread();
    useProjectStore.getState().selectProject(projectId);
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({
      newThreadProjectId: projectId,
      newThreadIdleOnly: idleOnly ?? false,
      allThreadsProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      reviewPaneOpen: false,
    });
  },

  cancelNewThread: () => {
    set({ newThreadProjectId: null, newThreadIdleOnly: false });
  },

  closeAllThreads: () => {
    set({ allThreadsProjectId: null });
  },

  showGlobalSearch: () => {
    invalidateSelectThread();
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({
      allThreadsProjectId: '__all__',
      newThreadProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      settingsOpen: false,
      analyticsOpen: false,
      liveColumnsOpen: false,
      reviewPaneOpen: false,
    });
  },

  setAnalyticsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
          }
        : { analyticsOpen: false },
    );
  },

  setLiveColumnsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
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
          }
        : { liveColumnsOpen: false },
    );
  },

  setTimelineVisible: (visible) => {
    try {
      localStorage.setItem(TIMELINE_VISIBLE_KEY, String(visible));
    } catch {}
    set({ timelineVisible: visible });
  },
  setKanbanContext: (context) => set({ kanbanContext: context }),
}));
