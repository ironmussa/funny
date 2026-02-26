import { describe, test, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted() so these mocks are available when vi.mock factories run (which are hoisted)
const { mockSelectProject, mockSetState, mockInvalidateSelectThread } = vi.hoisted(() => ({
  mockSelectProject: vi.fn(),
  mockSetState: vi.fn(),
  mockInvalidateSelectThread: vi.fn(),
}));

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ selectProject: mockSelectProject }),
  },
}));

vi.mock('@/stores/thread-store', () => ({
  useThreadStore: {
    setState: mockSetState,
    getState: () => ({}),
  },
  invalidateSelectThread: mockInvalidateSelectThread,
}));

import { useUIStore } from '@/stores/ui-store';

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset the store to its initial state
    useUIStore.setState({
      reviewPaneOpen: false,
      settingsOpen: false,
      activeSettingsPage: null,
      newThreadProjectId: null,
      newThreadIdleOnly: false,
      allThreadsProjectId: null,
      automationInboxOpen: false,
      addProjectOpen: false,
      analyticsOpen: false,
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    test('reviewPaneOpen is false', () => {
      expect(useUIStore.getState().reviewPaneOpen).toBe(false);
    });

    test('settingsOpen is false', () => {
      expect(useUIStore.getState().settingsOpen).toBe(false);
    });

    test('activeSettingsPage is null', () => {
      expect(useUIStore.getState().activeSettingsPage).toBeNull();
    });

    test('newThreadProjectId is null', () => {
      expect(useUIStore.getState().newThreadProjectId).toBeNull();
    });

    test('newThreadIdleOnly is false', () => {
      expect(useUIStore.getState().newThreadIdleOnly).toBe(false);
    });

    test('allThreadsProjectId is null', () => {
      expect(useUIStore.getState().allThreadsProjectId).toBeNull();
    });

    test('automationInboxOpen is false', () => {
      expect(useUIStore.getState().automationInboxOpen).toBe(false);
    });

    test('addProjectOpen is false', () => {
      expect(useUIStore.getState().addProjectOpen).toBe(false);
    });

    test('analyticsOpen is false', () => {
      expect(useUIStore.getState().analyticsOpen).toBe(false);
    });
  });

  describe('setReviewPaneOpen', () => {
    test('opens review pane', () => {
      useUIStore.getState().setReviewPaneOpen(true);
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
    });

    test('closes review pane', () => {
      useUIStore.setState({ reviewPaneOpen: true });
      useUIStore.getState().setReviewPaneOpen(false);
      expect(useUIStore.getState().reviewPaneOpen).toBe(false);
    });

    test('toggling multiple times works correctly', () => {
      useUIStore.getState().setReviewPaneOpen(true);
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
      useUIStore.getState().setReviewPaneOpen(false);
      expect(useUIStore.getState().reviewPaneOpen).toBe(false);
      useUIStore.getState().setReviewPaneOpen(true);
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
    });
  });

  describe('setSettingsOpen', () => {
    test('opening settings closes automationInbox and addProject', () => {
      useUIStore.setState({ automationInboxOpen: true, addProjectOpen: true });
      useUIStore.getState().setSettingsOpen(true);
      expect(useUIStore.getState().settingsOpen).toBe(true);
      expect(useUIStore.getState().automationInboxOpen).toBe(false);
      expect(useUIStore.getState().addProjectOpen).toBe(false);
    });

    test('closing settings clears activeSettingsPage', () => {
      useUIStore.setState({ settingsOpen: true, activeSettingsPage: 'users' });
      useUIStore.getState().setSettingsOpen(false);
      expect(useUIStore.getState().settingsOpen).toBe(false);
      expect(useUIStore.getState().activeSettingsPage).toBeNull();
    });

    test('opening settings preserves existing activeSettingsPage', () => {
      useUIStore.setState({ activeSettingsPage: 'profile' });
      useUIStore.getState().setSettingsOpen(true);
      expect(useUIStore.getState().settingsOpen).toBe(true);
      // activeSettingsPage is not explicitly set in the open path, so it keeps existing value
      expect(useUIStore.getState().activeSettingsPage).toBe('profile');
    });
  });

  describe('setActiveSettingsPage', () => {
    test('sets the active settings page', () => {
      useUIStore.getState().setActiveSettingsPage('profile');
      expect(useUIStore.getState().activeSettingsPage).toBe('profile');
    });

    test('clears the active settings page with null', () => {
      useUIStore.setState({ activeSettingsPage: 'profile' });
      useUIStore.getState().setActiveSettingsPage(null);
      expect(useUIStore.getState().activeSettingsPage).toBeNull();
    });
  });

  describe('startNewThread', () => {
    test('sets projectId and clears other panels', () => {
      useUIStore.setState({
        allThreadsProjectId: '__all__',
        automationInboxOpen: true,
        addProjectOpen: true,
      });
      useUIStore.getState().startNewThread('project-1');

      const state = useUIStore.getState();
      expect(state.newThreadProjectId).toBe('project-1');
      expect(state.newThreadIdleOnly).toBe(false);
      expect(state.allThreadsProjectId).toBeNull();
      expect(state.automationInboxOpen).toBe(false);
      expect(state.addProjectOpen).toBe(false);
    });

    test('calls selectProject with the project id', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(mockSelectProject).toHaveBeenCalledWith('project-1');
    });

    test('calls invalidateSelectThread', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(mockInvalidateSelectThread).toHaveBeenCalled();
    });

    test('clears thread selection via useThreadStore.setState', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(mockSetState).toHaveBeenCalledWith({ selectedThreadId: null, activeThread: null });
    });

    test('sets idleOnly when passed true', () => {
      useUIStore.getState().startNewThread('project-1', true);
      expect(useUIStore.getState().newThreadIdleOnly).toBe(true);
    });

    test('defaults idleOnly to false when not passed', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(useUIStore.getState().newThreadIdleOnly).toBe(false);
    });
  });

  describe('cancelNewThread', () => {
    test('resets newThreadProjectId to null', () => {
      useUIStore.setState({ newThreadProjectId: 'project-1' });
      useUIStore.getState().cancelNewThread();
      expect(useUIStore.getState().newThreadProjectId).toBeNull();
    });

    test('resets newThreadIdleOnly to false', () => {
      useUIStore.setState({ newThreadProjectId: 'project-1', newThreadIdleOnly: true });
      useUIStore.getState().cancelNewThread();
      expect(useUIStore.getState().newThreadIdleOnly).toBe(false);
    });
  });

  describe('closeAllThreads', () => {
    test('clears allThreadsProjectId', () => {
      useUIStore.setState({ allThreadsProjectId: '__all__' });
      useUIStore.getState().closeAllThreads();
      expect(useUIStore.getState().allThreadsProjectId).toBeNull();
    });
  });

  describe('setAutomationInboxOpen', () => {
    test('opening closes other panels', () => {
      useUIStore.setState({
        reviewPaneOpen: true,
        settingsOpen: true,
        activeSettingsPage: 'profile',
        allThreadsProjectId: '__all__',
        addProjectOpen: true,
      });
      useUIStore.getState().setAutomationInboxOpen(true);

      const state = useUIStore.getState();
      expect(state.automationInboxOpen).toBe(true);
      expect(state.reviewPaneOpen).toBe(false);
      expect(state.settingsOpen).toBe(false);
      expect(state.activeSettingsPage).toBeNull();
      expect(state.allThreadsProjectId).toBeNull();
      expect(state.addProjectOpen).toBe(false);
    });

    test('opening calls invalidateSelectThread', () => {
      useUIStore.getState().setAutomationInboxOpen(true);
      expect(mockInvalidateSelectThread).toHaveBeenCalled();
    });

    test('opening clears thread selection', () => {
      useUIStore.getState().setAutomationInboxOpen(true);
      expect(mockSetState).toHaveBeenCalledWith({ selectedThreadId: null, activeThread: null });
    });

    test('closing only sets automationInboxOpen to false', () => {
      useUIStore.setState({
        automationInboxOpen: true,
        reviewPaneOpen: true,
        settingsOpen: true,
      });
      useUIStore.getState().setAutomationInboxOpen(false);
      expect(useUIStore.getState().automationInboxOpen).toBe(false);
      // Other state should remain unchanged
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
      expect(useUIStore.getState().settingsOpen).toBe(true);
    });

    test('closing does not call invalidateSelectThread', () => {
      useUIStore.getState().setAutomationInboxOpen(false);
      expect(mockInvalidateSelectThread).not.toHaveBeenCalled();
    });
  });

  describe('setAddProjectOpen', () => {
    test('opening closes other panels', () => {
      useUIStore.setState({
        settingsOpen: true,
        automationInboxOpen: true,
        allThreadsProjectId: '__all__',
        newThreadProjectId: 'project-2',
      });
      useUIStore.getState().setAddProjectOpen(true);

      const state = useUIStore.getState();
      expect(state.addProjectOpen).toBe(true);
      expect(state.settingsOpen).toBe(false);
      expect(state.automationInboxOpen).toBe(false);
      expect(state.allThreadsProjectId).toBeNull();
      expect(state.newThreadProjectId).toBeNull();
    });

    test('opening calls invalidateSelectThread', () => {
      useUIStore.getState().setAddProjectOpen(true);
      expect(mockInvalidateSelectThread).toHaveBeenCalled();
    });

    test('opening clears thread selection', () => {
      useUIStore.getState().setAddProjectOpen(true);
      expect(mockSetState).toHaveBeenCalledWith({ selectedThreadId: null, activeThread: null });
    });

    test('closing only sets addProjectOpen to false', () => {
      useUIStore.setState({ addProjectOpen: true, settingsOpen: true });
      useUIStore.getState().setAddProjectOpen(false);
      expect(useUIStore.getState().addProjectOpen).toBe(false);
      expect(useUIStore.getState().settingsOpen).toBe(true);
    });

    test('closing does not call invalidateSelectThread', () => {
      useUIStore.getState().setAddProjectOpen(false);
      expect(mockInvalidateSelectThread).not.toHaveBeenCalled();
    });
  });

  describe('showGlobalSearch', () => {
    test('sets allThreadsProjectId to __all__', () => {
      useUIStore.getState().showGlobalSearch();
      expect(useUIStore.getState().allThreadsProjectId).toBe('__all__');
    });

    test('clears other panels', () => {
      useUIStore.setState({
        newThreadProjectId: 'project-1',
        automationInboxOpen: true,
        addProjectOpen: true,
        settingsOpen: true,
        analyticsOpen: true,
      });
      useUIStore.getState().showGlobalSearch();

      const state = useUIStore.getState();
      expect(state.newThreadProjectId).toBeNull();
      expect(state.automationInboxOpen).toBe(false);
      expect(state.addProjectOpen).toBe(false);
      expect(state.settingsOpen).toBe(false);
      expect(state.analyticsOpen).toBe(false);
    });

    test('calls invalidateSelectThread', () => {
      useUIStore.getState().showGlobalSearch();
      expect(mockInvalidateSelectThread).toHaveBeenCalled();
    });

    test('clears thread selection', () => {
      useUIStore.getState().showGlobalSearch();
      expect(mockSetState).toHaveBeenCalledWith({ selectedThreadId: null, activeThread: null });
    });
  });

  describe('setAnalyticsOpen', () => {
    test('opening closes other panels', () => {
      useUIStore.setState({
        reviewPaneOpen: true,
        settingsOpen: true,
        activeSettingsPage: 'users',
        allThreadsProjectId: '__all__',
        addProjectOpen: true,
        automationInboxOpen: true,
      });
      useUIStore.getState().setAnalyticsOpen(true);

      const state = useUIStore.getState();
      expect(state.analyticsOpen).toBe(true);
      expect(state.reviewPaneOpen).toBe(false);
      expect(state.settingsOpen).toBe(false);
      expect(state.activeSettingsPage).toBeNull();
      expect(state.allThreadsProjectId).toBeNull();
      expect(state.addProjectOpen).toBe(false);
      expect(state.automationInboxOpen).toBe(false);
    });

    test('opening calls invalidateSelectThread', () => {
      useUIStore.getState().setAnalyticsOpen(true);
      expect(mockInvalidateSelectThread).toHaveBeenCalled();
    });

    test('opening clears thread selection', () => {
      useUIStore.getState().setAnalyticsOpen(true);
      expect(mockSetState).toHaveBeenCalledWith({ selectedThreadId: null, activeThread: null });
    });

    test('closing only sets analyticsOpen to false', () => {
      useUIStore.setState({ analyticsOpen: true, reviewPaneOpen: true });
      useUIStore.getState().setAnalyticsOpen(false);
      expect(useUIStore.getState().analyticsOpen).toBe(false);
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
    });

    test('closing does not call invalidateSelectThread', () => {
      useUIStore.getState().setAnalyticsOpen(false);
      expect(mockInvalidateSelectThread).not.toHaveBeenCalled();
    });
  });

  describe('panel mutual exclusivity', () => {
    test('opening settings then automation inbox closes settings', () => {
      useUIStore.getState().setSettingsOpen(true);
      expect(useUIStore.getState().settingsOpen).toBe(true);

      useUIStore.getState().setAutomationInboxOpen(true);
      expect(useUIStore.getState().automationInboxOpen).toBe(true);
      expect(useUIStore.getState().settingsOpen).toBe(false);
    });

    test('opening addProject then analytics closes addProject', () => {
      useUIStore.getState().setAddProjectOpen(true);
      expect(useUIStore.getState().addProjectOpen).toBe(true);

      useUIStore.getState().setAnalyticsOpen(true);
      expect(useUIStore.getState().analyticsOpen).toBe(true);
      expect(useUIStore.getState().addProjectOpen).toBe(false);
    });

    test('startNewThread then showGlobalSearch clears newThreadProjectId', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(useUIStore.getState().newThreadProjectId).toBe('project-1');

      useUIStore.getState().showGlobalSearch();
      expect(useUIStore.getState().newThreadProjectId).toBeNull();
      expect(useUIStore.getState().allThreadsProjectId).toBe('__all__');
    });
  });
});
