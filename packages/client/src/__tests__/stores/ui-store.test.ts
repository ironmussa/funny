import { describe, test, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted() so these mocks are available when vi.mock factories run (which are hoisted)
const { mockSelectProject, mockInvalidateSelectThread, mockClearThreadSelection, mockProjects } =
  vi.hoisted(() => ({
    mockSelectProject: vi.fn(),
    mockInvalidateSelectThread: vi.fn(),
    mockClearThreadSelection: vi.fn(),
    mockProjects: [] as Array<{ id: string; needsSetup?: boolean }>,
  }));

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ selectProject: mockSelectProject, projects: mockProjects }),
  },
}));

vi.mock('@/stores/thread-store-internals', () => ({
  invalidateSelectThread: mockInvalidateSelectThread,
  clearThreadSelection: mockClearThreadSelection,
  setThreadSelectListener: vi.fn(),
}));

import { useUIStore } from '@/stores/ui-store';

describe('useUIStore', () => {
  beforeEach(() => {
    mockProjects.length = 0;
    localStorage.clear();
    // Reset the store to its initial state
    useUIStore.setState({
      reviewPaneOpen: false,
      reviewPaneWidth: 28,
      rightPaneTab: 'activity',
      reviewSubTab: 'changes',
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
      generalSettingsOpen: false,
      commandPaletteOpen: false,
      fileSearchOpen: false,
      textSearchOpen: false,
      keyboardShortcutsOpen: false,
      kanbanContext: null,
      newThreadIssueContext: null,
      composePrefillPrompt: null,
      designViewProjectId: null,
      designViewDesignId: null,
      activeDesignId: null,
      designsListProjectId: null,
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

    test('clears thread selection via thread-store internals', () => {
      useUIStore.getState().startNewThread('project-1');
      expect(mockClearThreadSelection).toHaveBeenCalled();
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
      expect(mockClearThreadSelection).toHaveBeenCalled();
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
      expect(mockClearThreadSelection).toHaveBeenCalled();
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
      expect(mockClearThreadSelection).toHaveBeenCalled();
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
      expect(mockClearThreadSelection).toHaveBeenCalled();
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

  describe('startNewScratchThread', () => {
    test('enters scratch compose mode and clears project selection', () => {
      useUIStore.getState().startNewScratchThread();

      const state = useUIStore.getState();
      expect(state.newThreadIsScratch).toBe(true);
      expect(state.newThreadProjectId).toBeNull();
      expect(mockSelectProject).toHaveBeenCalledWith(null);
      expect(mockClearThreadSelection).toHaveBeenCalled();
    });
  });

  describe('startNewThread guards', () => {
    test('does not open compose when project needs setup', () => {
      mockProjects.push({ id: 'p-setup', needsSetup: true });

      useUIStore.getState().startNewThread('p-setup');

      expect(useUIStore.getState().newThreadProjectId).toBeNull();
      expect(mockSelectProject).not.toHaveBeenCalled();
    });
  });

  describe('cancelNewThread scratch + issue context', () => {
    test('clears scratch and issue context flags', () => {
      useUIStore.setState({
        newThreadProjectId: 'p1',
        newThreadIsScratch: true,
        newThreadIssueContext: { prompt: 'fix', branchName: 'fix-1', title: 'Fix' },
      });

      useUIStore.getState().cancelNewThread();

      const state = useUIStore.getState();
      expect(state.newThreadIsScratch).toBe(false);
      expect(state.newThreadIssueContext).toBeNull();
    });
  });

  describe('review pane layout', () => {
    test('setReviewPaneWidth clamps to min/max and persists', () => {
      useUIStore.getState().setReviewPaneWidth(5);
      expect(useUIStore.getState().reviewPaneWidth).toBe(20);

      useUIStore.getState().setReviewPaneWidth(999);
      expect(useUIStore.getState().reviewPaneWidth).toBe(70);
      expect(localStorage.getItem('review_pane_width')).toBe('70');
    });

    test('setRightPaneTab opens review pane on selected tab', () => {
      useUIStore.getState().setRightPaneTab('files');
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
      expect(useUIStore.getState().rightPaneTab).toBe('files');
    });

    test('setActivityPaneOpen switches to activity tab', () => {
      useUIStore.getState().setActivityPaneOpen(true);
      expect(useUIStore.getState().rightPaneTab).toBe('activity');
      expect(useUIStore.getState().reviewPaneOpen).toBe(true);
    });

    test('setReviewSubTab persists valid tab', () => {
      useUIStore.getState().setReviewSubTab('stash');
      expect(useUIStore.getState().reviewSubTab).toBe('stash');
      expect(localStorage.getItem('review_sub_tab')).toBe('stash');
    });
  });

  describe('search + palette toggles', () => {
    test('opening command palette closes other search dialogs', () => {
      useUIStore.setState({ fileSearchOpen: true, textSearchOpen: true });
      useUIStore.getState().setCommandPaletteOpen(true);

      const state = useUIStore.getState();
      expect(state.commandPaletteOpen).toBe(true);
      expect(state.fileSearchOpen).toBe(false);
      expect(state.textSearchOpen).toBe(false);
    });

    test('toggleTextSearch opens and closes text search', () => {
      useUIStore.getState().toggleTextSearch();
      expect(useUIStore.getState().textSearchOpen).toBe(true);
      useUIStore.getState().toggleTextSearch();
      expect(useUIStore.getState().textSearchOpen).toBe(false);
    });

    test('setTextSearchState merges partial state', () => {
      useUIStore.getState().setTextSearchState({ query: 'auth middleware', regex: true });
      expect(useUIStore.getState().textSearchState.query).toBe('auth middleware');
      expect(useUIStore.getState().textSearchState.regex).toBe(true);
      expect(useUIStore.getState().textSearchState.caseSensitive).toBe(false);
    });
  });

  describe('secondary panels', () => {
    test('setOrchestratorOpen clears competing panels when opening', () => {
      useUIStore.setState({ analyticsOpen: true, reviewPaneOpen: true });
      useUIStore.getState().setOrchestratorOpen(true);

      const state = useUIStore.getState();
      expect(state.orchestratorOpen).toBe(true);
      expect(state.analyticsOpen).toBe(false);
      expect(state.reviewPaneOpen).toBe(false);
      expect(mockClearThreadSelection).toHaveBeenCalled();
    });

    test('setLiveColumnsOpen clears analytics when opening', () => {
      useUIStore.setState({ analyticsOpen: true });
      useUIStore.getState().setLiveColumnsOpen(true);
      expect(useUIStore.getState().liveColumnsOpen).toBe(true);
      expect(useUIStore.getState().analyticsOpen).toBe(false);
    });

    test('setGeneralSettingsOpen closes review pane and settings', () => {
      useUIStore.setState({ settingsOpen: true, reviewPaneOpen: true });
      useUIStore.getState().setGeneralSettingsOpen(true);
      expect(useUIStore.getState().generalSettingsOpen).toBe(true);
      expect(useUIStore.getState().settingsOpen).toBe(false);
      expect(useUIStore.getState().reviewPaneOpen).toBe(false);
    });

    test('setTestRunnerOpen closes review pane and clears thread selection', () => {
      useUIStore.setState({ reviewPaneOpen: true });
      useUIStore.getState().setTestRunnerOpen(true);
      expect(useUIStore.getState().testRunnerOpen).toBe(true);
      expect(useUIStore.getState().reviewPaneOpen).toBe(false);
      expect(mockClearThreadSelection).toHaveBeenCalled();
    });
  });

  describe('design + kanban flows', () => {
    test('setDesignView stores design context and closes overlays', () => {
      useUIStore.setState({ settingsOpen: true, orchestratorOpen: true });
      useUIStore.getState().setDesignView('p1', 'd1');

      const state = useUIStore.getState();
      expect(state.designViewProjectId).toBe('p1');
      expect(state.designViewDesignId).toBe('d1');
      expect(state.activeDesignId).toBe('d1');
      expect(state.settingsOpen).toBe(false);
      expect(state.orchestratorOpen).toBe(false);
    });

    test('closeDesignView clears design context', () => {
      useUIStore.setState({
        designViewProjectId: 'p1',
        designViewDesignId: 'd1',
        activeDesignId: 'd1',
      });
      useUIStore.getState().closeDesignView();
      expect(useUIStore.getState().designViewDesignId).toBeNull();
      expect(useUIStore.getState().activeDesignId).toBeNull();
    });

    test('setKanbanContext stores board context', () => {
      useUIStore.getState().setKanbanContext({ projectId: 'p1', viewMode: 'board' });
      expect(useUIStore.getState().kanbanContext).toEqual({ projectId: 'p1', viewMode: 'board' });
    });

    test('setKanbanContext with threadId + search seeds pendingThreadSearch', () => {
      useUIStore.getState().setKanbanContext({
        projectId: 'p1',
        search: '  foo  ',
        caseSensitive: true,
        threadId: 't1',
        viewMode: 'list',
      });
      expect(useUIStore.getState().pendingThreadSearch).toEqual({
        threadId: 't1',
        query: 'foo',
        caseSensitive: true,
      });
    });

    test('setKanbanContext with threadId but no search clears stale pendingThreadSearch', () => {
      useUIStore.setState({
        pendingThreadSearch: { threadId: 'old', query: 'stale', caseSensitive: false },
      });
      useUIStore.getState().setKanbanContext({ projectId: 'p1', threadId: 't2', search: '' });
      expect(useUIStore.getState().pendingThreadSearch).toBeNull();
    });

    test('setKanbanContext(null) leaves pendingThreadSearch untouched', () => {
      const pending = { threadId: 't1', query: 'foo', caseSensitive: false };
      useUIStore.setState({ pendingThreadSearch: pending });
      useUIStore.getState().setKanbanContext(null);
      expect(useUIStore.getState().pendingThreadSearch).toEqual(pending);
    });

    test('setPendingThreadSearch sets and clears', () => {
      useUIStore
        .getState()
        .setPendingThreadSearch({ threadId: 't1', query: 'q', caseSensitive: false });
      expect(useUIStore.getState().pendingThreadSearch).toEqual({
        threadId: 't1',
        query: 'q',
        caseSensitive: false,
      });
      useUIStore.getState().setPendingThreadSearch(null);
      expect(useUIStore.getState().pendingThreadSearch).toBeNull();
    });
  });

  describe('issue + compose helpers', () => {
    test('startNewThreadFromIssue sets issue context then opens compose', () => {
      const issue = { prompt: 'Fix bug', branchName: 'fix/bug', title: 'Bug' };
      useUIStore.getState().startNewThreadFromIssue('p1', issue);

      expect(useUIStore.getState().newThreadIssueContext).toEqual(issue);
      expect(useUIStore.getState().newThreadProjectId).toBe('p1');
    });

    test('setComposePrefillPrompt stores and clears prefill', () => {
      useUIStore.getState().setComposePrefillPrompt('from annotator');
      expect(useUIStore.getState().composePrefillPrompt).toBe('from annotator');
      useUIStore.getState().setComposePrefillPrompt(null);
      expect(useUIStore.getState().composePrefillPrompt).toBeNull();
    });
  });

  describe('settings navigation', () => {
    test('setSettingsReturnPath stores back navigation target', () => {
      useUIStore.getState().setSettingsReturnPath('/projects/p1');
      expect(useUIStore.getState().settingsReturnPath).toBe('/projects/p1');
    });

    test('setTimelineVisible persists visibility flag', () => {
      useUIStore.getState().setTimelineVisible(true);
      expect(useUIStore.getState().timelineVisible).toBe(true);
      expect(localStorage.getItem('timeline_visible')).toBe('true');
    });
  });

  describe('grid selected thread', () => {
    test('setGridSelectedThreadId sets state and persists to localStorage', () => {
      useUIStore.getState().setGridSelectedThreadId('thread-7');
      expect(useUIStore.getState().gridSelectedThreadId).toBe('thread-7');
      expect(localStorage.getItem('funny:grid-selected-thread:v1')).toBe('thread-7');
    });

    test('setGridSelectedThreadId(null) clears state and removes the key', () => {
      useUIStore.getState().setGridSelectedThreadId('thread-7');
      useUIStore.getState().setGridSelectedThreadId(null);
      expect(useUIStore.getState().gridSelectedThreadId).toBeNull();
      expect(localStorage.getItem('funny:grid-selected-thread:v1')).toBeNull();
    });

    test('round-trips a new selection over an existing one', () => {
      useUIStore.getState().setGridSelectedThreadId('thread-a');
      useUIStore.getState().setGridSelectedThreadId('thread-b');
      expect(useUIStore.getState().gridSelectedThreadId).toBe('thread-b');
      expect(localStorage.getItem('funny:grid-selected-thread:v1')).toBe('thread-b');
    });
  });
});
