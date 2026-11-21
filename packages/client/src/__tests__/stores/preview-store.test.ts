import { describe, test, expect, beforeEach } from 'bun:test';

import { usePreviewStore } from '@/stores/preview-store';
import type { PreviewTab } from '@/stores/preview-store';

const tab1: PreviewTab = {
  commandId: 'cmd-1',
  projectId: 'proj-1',
  port: 3000,
  label: 'Dev Server',
};

const tab2: PreviewTab = {
  commandId: 'cmd-2',
  projectId: 'proj-1',
  port: 3001,
  label: 'Storybook',
};

const tab3: PreviewTab = {
  commandId: 'cmd-3',
  projectId: 'proj-2',
  port: 8080,
  label: 'API Server',
};

describe('usePreviewStore', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      tabs: [],
      activeTabId: null,
      windowOpen: false,
    });
  });

  describe('addTab', () => {
    test('adds a new tab and sets it active', () => {
      usePreviewStore.getState().addTab(tab1);

      const state = usePreviewStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]).toEqual(tab1);
      expect(state.activeTabId).toBe('cmd-1');
    });

    test('does not duplicate existing tab, just activates it', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);
      expect(usePreviewStore.getState().activeTabId).toBe('cmd-2');

      // Add tab1 again — should not duplicate, but should activate it
      usePreviewStore.getState().addTab(tab1);

      const state = usePreviewStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe('cmd-1');
    });
  });

  describe('removeTab', () => {
    test('removes tab and adjusts activeTabId when active tab is removed', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);
      // tab2 is active
      expect(usePreviewStore.getState().activeTabId).toBe('cmd-2');

      usePreviewStore.getState().removeTab('cmd-2');

      const state = usePreviewStore.getState();
      expect(state.tabs).toHaveLength(1);
      // Should fall back to the last remaining tab
      expect(state.activeTabId).toBe('cmd-1');
    });

    test('keeps activeTabId if not the removed tab', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);
      // tab2 is active
      expect(usePreviewStore.getState().activeTabId).toBe('cmd-2');

      usePreviewStore.getState().removeTab('cmd-1');

      const state = usePreviewStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.activeTabId).toBe('cmd-2');
    });

    test('sets activeTabId to null when last tab is removed', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().removeTab('cmd-1');

      expect(usePreviewStore.getState().tabs).toHaveLength(0);
      expect(usePreviewStore.getState().activeTabId).toBeNull();
    });
  });

  describe('removeTabsForProject', () => {
    test('removes all tabs for a project', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);
      usePreviewStore.getState().addTab(tab3);

      // Remove all tabs for proj-1
      usePreviewStore.getState().removeTabsForProject('proj-1');

      const state = usePreviewStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].commandId).toBe('cmd-3');
      expect(state.activeTabId).toBe('cmd-3');
    });

    test('adjusts activeTabId when active tab is in removed project', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);
      usePreviewStore.getState().addTab(tab3);
      // Activate a tab from proj-1
      usePreviewStore.getState().setActiveTab('cmd-1');

      usePreviewStore.getState().removeTabsForProject('proj-1');

      expect(usePreviewStore.getState().activeTabId).toBe('cmd-3');
    });

    test('sets activeTabId to null when all tabs removed', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);

      usePreviewStore.getState().removeTabsForProject('proj-1');

      expect(usePreviewStore.getState().tabs).toHaveLength(0);
      expect(usePreviewStore.getState().activeTabId).toBeNull();
    });
  });

  describe('setActiveTab', () => {
    test('sets the active tab', () => {
      usePreviewStore.getState().addTab(tab1);
      usePreviewStore.getState().addTab(tab2);

      usePreviewStore.getState().setActiveTab('cmd-1');
      expect(usePreviewStore.getState().activeTabId).toBe('cmd-1');
    });
  });

  describe('setWindowOpen', () => {
    test('sets window open state to true', () => {
      usePreviewStore.getState().setWindowOpen(true);
      expect(usePreviewStore.getState().windowOpen).toBe(true);
    });

    test('sets window open state to false', () => {
      usePreviewStore.setState({ windowOpen: true });
      usePreviewStore.getState().setWindowOpen(false);
      expect(usePreviewStore.getState().windowOpen).toBe(false);
    });
  });

  describe('hasTab', () => {
    test('returns true when tab exists', () => {
      usePreviewStore.getState().addTab(tab1);
      expect(usePreviewStore.getState().hasTab('cmd-1')).toBe(true);
    });

    test('returns false when tab does not exist', () => {
      expect(usePreviewStore.getState().hasTab('nonexistent')).toBe(false);
    });
  });

  describe('getTab', () => {
    test('returns the tab when it exists', () => {
      usePreviewStore.getState().addTab(tab1);
      expect(usePreviewStore.getState().getTab('cmd-1')).toEqual(tab1);
    });

    test('returns undefined when tab does not exist', () => {
      expect(usePreviewStore.getState().getTab('nonexistent')).toBeUndefined();
    });
  });
});
