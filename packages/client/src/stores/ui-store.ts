import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useThreadStore, invalidateSelectThread } from './thread-store';

interface UIState {
  reviewPaneOpen: boolean;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  newThreadProjectId: string | null;
  allThreadsProjectId: string | null;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;

  setReviewPaneOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
  startNewThread: (projectId: string) => void;
  cancelNewThread: () => void;
  showAllThreads: (projectId: string) => void;
  closeAllThreads: () => void;
  setAutomationInboxOpen: (open: boolean) => void;
  setAddProjectOpen: (open: boolean) => void;
  showGlobalSearch: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  reviewPaneOpen: false,
  settingsOpen: false,
  activeSettingsPage: null,
  newThreadProjectId: null,
  allThreadsProjectId: null,
  automationInboxOpen: false,
  addProjectOpen: false,

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

  startNewThread: (projectId: string) => {
    invalidateSelectThread();
    useProjectStore.getState().selectProject(projectId);
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({ newThreadProjectId: projectId, allThreadsProjectId: null, automationInboxOpen: false, addProjectOpen: false });
  },

  cancelNewThread: () => {
    set({ newThreadProjectId: null });
  },

  showAllThreads: (projectId: string) => {
    invalidateSelectThread();
    useProjectStore.getState().selectProject(projectId);
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({ allThreadsProjectId: projectId, newThreadProjectId: null, automationInboxOpen: false, addProjectOpen: false });
  },

  closeAllThreads: () => {
    set({ allThreadsProjectId: null });
  },

  showGlobalSearch: () => {
    invalidateSelectThread();
    useThreadStore.setState({ selectedThreadId: null, activeThread: null });
    set({ allThreadsProjectId: '__all__', newThreadProjectId: null, automationInboxOpen: false, addProjectOpen: false, settingsOpen: false });
  },
}));
