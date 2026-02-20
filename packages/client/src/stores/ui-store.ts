import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useThreadStore, invalidateSelectThread } from './thread-store';

interface UIState {
  reviewPaneOpen: boolean;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  newThreadProjectId: string | null;
  newThreadIdleOnly: boolean;
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  kanbanContext: { projectId?: string; search?: string; threadId?: string } | null;

  setReviewPaneOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
  startNewThread: (projectId: string, idleOnly?: boolean) => void;
  cancelNewThread: () => void;
  closeAllThreads: () => void;
  setAutomationInboxOpen: (open: boolean) => void;
  setAddProjectOpen: (open: boolean) => void;
  showGlobalSearch: () => void;
  setAnalyticsOpen: (open: boolean) => void;
  setLiveColumnsOpen: (open: boolean) => void;
  setKanbanContext: (context: { projectId?: string; search?: string; threadId?: string } | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  reviewPaneOpen: false,
  settingsOpen: false,
  activeSettingsPage: null,
  newThreadProjectId: null,
  newThreadIdleOnly: false,
  allThreadsProjectId: null,
  automationInboxOpen: false,
  addProjectOpen: false,
  analyticsOpen: false,
  liveColumnsOpen: false,
  kanbanContext: null,

  setReviewPaneOpen: (open) => set({ reviewPaneOpen: open }),
  setSettingsOpen: (open) => set(open ? { settingsOpen: true, automationInboxOpen: false, addProjectOpen: false } : { settingsOpen: false, activeSettingsPage: null }),
  setActiveSettingsPage: (page) => set({ activeSettingsPage: page }),
  setAutomationInboxOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    }
    set(open ? { automationInboxOpen: true, reviewPaneOpen: false, settingsOpen: false, activeSettingsPage: null, allThreadsProjectId: null, addProjectOpen: false } : { automationInboxOpen: false });
  },

  setAddProjectOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
      set({ addProjectOpen: true, settingsOpen: false, automationInboxOpen: false, allThreadsProjectId: null, newThreadProjectId: null });
    } else {
      set({ addProjectOpen: false });
    }
  },

  startNewThread: (projectId: string, idleOnly?: boolean) => {
    invalidateSelectThread();
    useProjectStore.getState().selectProject(projectId);
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({ newThreadProjectId: projectId, newThreadIdleOnly: idleOnly ?? false, allThreadsProjectId: null, automationInboxOpen: false, addProjectOpen: false });
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
    set({ allThreadsProjectId: '__all__', newThreadProjectId: null, automationInboxOpen: false, addProjectOpen: false, settingsOpen: false, analyticsOpen: false });
  },

  setAnalyticsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    }
    set(open ? { analyticsOpen: true, reviewPaneOpen: false, settingsOpen: false, activeSettingsPage: null, allThreadsProjectId: null, addProjectOpen: false, automationInboxOpen: false, liveColumnsOpen: false } : { analyticsOpen: false });
  },

  setLiveColumnsOpen: (open) => {
    if (open) {
      invalidateSelectThread();
      useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    }
    set(open ? { liveColumnsOpen: true, reviewPaneOpen: false, settingsOpen: false, activeSettingsPage: null, allThreadsProjectId: null, addProjectOpen: false, automationInboxOpen: false, analyticsOpen: false } : { liveColumnsOpen: false });
  },

  setKanbanContext: (context) => set({ kanbanContext: context }),
}));
