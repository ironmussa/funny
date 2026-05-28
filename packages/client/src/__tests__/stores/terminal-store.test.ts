import { describe, test, expect, beforeEach, vi } from 'vitest';

import { useTerminalStore } from '@/stores/terminal-store';
import type { TerminalTab } from '@/stores/terminal-store';

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: `tab-${Math.random().toString(36).slice(2, 8)}`,
    label: 'Test Terminal',
    cwd: '/tmp/test',
    alive: true,
    projectId: 'project-1',
    ...overrides,
  };
}

describe('useTerminalStore', () => {
  beforeEach(() => {
    // Reset to initial state
    useTerminalStore.setState({
      tabs: [],
      activeTabId: null,
      panelVisibleByProject: {},
      commandOutput: {},
      ptyDataCallbacks: {},
    });
  });

  describe('initial state', () => {
    test('has empty tabs', () => {
      expect(useTerminalStore.getState().tabs).toEqual([]);
    });

    test('has null activeTabId', () => {
      expect(useTerminalStore.getState().activeTabId).toBeNull();
    });

    test('has empty panelVisibleByProject', () => {
      expect(useTerminalStore.getState().panelVisibleByProject).toEqual({});
    });

    test('has empty commandOutput', () => {
      expect(useTerminalStore.getState().commandOutput).toEqual({});
    });

    test('has empty ptyDataCallbacks', () => {
      expect(useTerminalStore.getState().ptyDataCallbacks).toEqual({});
    });
  });

  describe('addTab', () => {
    test('adds a tab to the list', () => {
      const tab = makeTab({ id: 'tab-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0]).toMatchObject(tab);
    });

    test('sets the new tab as active', () => {
      const tab = makeTab({ id: 'tab-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().activeTabId).toBe('tab-1');
    });

    test('shows the panel for the tab project', () => {
      const tab = makeTab({ id: 'tab-1', projectId: 'project-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);
    });

    test('adding multiple tabs keeps the last one active', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      const tab3 = makeTab({ id: 'tab-3' });

      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);
      useTerminalStore.getState().addTab(tab3);

      expect(useTerminalStore.getState().tabs).toHaveLength(3);
      expect(useTerminalStore.getState().activeTabId).toBe('tab-3');
    });
  });

  describe('removeTab', () => {
    test('removes the specified tab', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0].id).toBe('tab-2');
    });

    test('removing active tab switches to the last remaining tab', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      const tab3 = makeTab({ id: 'tab-3' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);
      useTerminalStore.getState().addTab(tab3);

      // tab-3 is active; remove it
      useTerminalStore.getState().removeTab('tab-3');
      expect(useTerminalStore.getState().activeTabId).toBe('tab-2');
    });

    test('removing non-active tab keeps current active', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      const tab3 = makeTab({ id: 'tab-3' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);
      useTerminalStore.getState().addTab(tab3);

      // tab-3 is active; remove tab-1
      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().activeTabId).toBe('tab-3');
    });

    test('removing the last tab for a project hides the panel for that project', () => {
      const tab = makeTab({ id: 'tab-1', projectId: 'project-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(false);
      expect(useTerminalStore.getState().activeTabId).toBeNull();
    });

    test('removing tab with commandId cleans up commandOutput', () => {
      const tab = makeTab({ id: 'tab-1', commandId: 'cmd-1' });
      useTerminalStore.getState().addTab(tab);
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'some output');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBe('some output');

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBeUndefined();
    });

    test('removing tab without commandId does not affect commandOutput', () => {
      const cmdTab = makeTab({ id: 'tab-cmd', commandId: 'cmd-1' });
      const ptyTab = makeTab({ id: 'tab-pty' });
      useTerminalStore.getState().addTab(cmdTab);
      useTerminalStore.getState().addTab(ptyTab);
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'output');

      useTerminalStore.getState().removeTab('tab-pty');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBe('output');
    });

    test('removing non-last tab for a project keeps panel visible for that project', () => {
      const tab1 = makeTab({ id: 'tab-1', projectId: 'project-1' });
      const tab2 = makeTab({ id: 'tab-2', projectId: 'project-1' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);
    });

    test('removing last tab for one project does not affect another project panel', () => {
      const tab1 = makeTab({ id: 'tab-1', projectId: 'project-1' });
      const tab2 = makeTab({ id: 'tab-2', projectId: 'project-2' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(false);
      expect(useTerminalStore.getState().panelVisibleByProject['project-2']).toBe(true);
    });
  });

  describe('setActiveTab', () => {
    test('sets the active tab id', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().setActiveTab('tab-1');
      expect(useTerminalStore.getState().activeTabId).toBe('tab-1');
    });
  });

  describe('markExited', () => {
    test('sets alive to false for the specified tab', () => {
      const tab = makeTab({ id: 'tab-1', alive: true });
      useTerminalStore.getState().addTab(tab);

      useTerminalStore.getState().markExited('tab-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(false);
    });

    test('does not affect other tabs', () => {
      const tab1 = makeTab({ id: 'tab-1', alive: true });
      const tab2 = makeTab({ id: 'tab-2', alive: true });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().markExited('tab-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(false);
      expect(useTerminalStore.getState().tabs[1].alive).toBe(true);
    });

    test('does nothing for non-existent tab id', () => {
      const tab = makeTab({ id: 'tab-1', alive: true });
      useTerminalStore.getState().addTab(tab);

      useTerminalStore.getState().markExited('nonexistent');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(true);
    });
  });

  describe('setPanelVisible / togglePanel', () => {
    test('setPanelVisible sets the value for a project', () => {
      useTerminalStore.getState().setPanelVisible('project-1', true);
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);

      useTerminalStore.getState().setPanelVisible('project-1', false);
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(false);
    });

    test('togglePanel flips the value for a project', () => {
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBeUndefined();

      useTerminalStore.getState().togglePanel('project-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);

      useTerminalStore.getState().togglePanel('project-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(false);
    });

    test('togglePanel works after setPanelVisible', () => {
      useTerminalStore.getState().setPanelVisible('project-1', true);
      useTerminalStore.getState().togglePanel('project-1');
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(false);
    });

    test('per-project visibility is independent', () => {
      useTerminalStore.getState().setPanelVisible('project-1', true);
      useTerminalStore.getState().setPanelVisible('project-2', false);
      expect(useTerminalStore.getState().panelVisibleByProject['project-1']).toBe(true);
      expect(useTerminalStore.getState().panelVisibleByProject['project-2']).toBe(false);
    });
  });

  describe('appendCommandOutput', () => {
    test('accumulates output data for a command', () => {
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'hello ');
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'world');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBe('hello world');
    });

    test('creates entry on first call', () => {
      useTerminalStore.getState().appendCommandOutput('cmd-new', 'first');
      expect(useTerminalStore.getState().commandOutput['cmd-new']).toBe('first');
    });

    test('handles multiple commands independently', () => {
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'output-1');
      useTerminalStore.getState().appendCommandOutput('cmd-2', 'output-2');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBe('output-1');
      expect(useTerminalStore.getState().commandOutput['cmd-2']).toBe('output-2');
    });

    test('handles empty string appends', () => {
      useTerminalStore.getState().appendCommandOutput('cmd-1', 'start');
      useTerminalStore.getState().appendCommandOutput('cmd-1', '');
      expect(useTerminalStore.getState().commandOutput['cmd-1']).toBe('start');
    });

    test('handles large output accumulation', () => {
      for (let i = 0; i < 100; i++) {
        useTerminalStore.getState().appendCommandOutput('cmd-1', `line ${i}\n`);
      }
      const output = useTerminalStore.getState().commandOutput['cmd-1'];
      expect(output).toContain('line 0');
      expect(output).toContain('line 99');
    });
  });

  describe('markCommandExited', () => {
    test('sets alive to false for the tab matching commandId', () => {
      const tab = makeTab({ id: 'tab-1', commandId: 'cmd-1', alive: true });
      useTerminalStore.getState().addTab(tab);

      useTerminalStore.getState().markCommandExited('cmd-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(false);
    });

    test('does not affect tabs with different commandId', () => {
      const tab1 = makeTab({ id: 'tab-1', commandId: 'cmd-1', alive: true });
      const tab2 = makeTab({ id: 'tab-2', commandId: 'cmd-2', alive: true });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().markCommandExited('cmd-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(false);
      expect(useTerminalStore.getState().tabs[1].alive).toBe(true);
    });

    test('does not affect tabs without commandId', () => {
      const tab1 = makeTab({ id: 'tab-1', alive: true }); // no commandId
      const tab2 = makeTab({ id: 'tab-2', commandId: 'cmd-1', alive: true });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().markCommandExited('cmd-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(true);
      expect(useTerminalStore.getState().tabs[1].alive).toBe(false);
    });
  });

  describe('pty callback lifecycle', () => {
    test('registerPtyCallback stores the callback', () => {
      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', callback);
      expect(useTerminalStore.getState().ptyDataCallbacks['pty-1']).toBe(callback);
    });

    test('unregisterPtyCallback removes the callback', () => {
      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', callback);
      useTerminalStore.getState().unregisterPtyCallback('pty-1');
      expect(useTerminalStore.getState().ptyDataCallbacks['pty-1']).toBeUndefined();
    });

    test('unregisterPtyCallback does not affect other callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', cb1);
      useTerminalStore.getState().registerPtyCallback('pty-2', cb2);

      useTerminalStore.getState().unregisterPtyCallback('pty-1');
      expect(useTerminalStore.getState().ptyDataCallbacks['pty-1']).toBeUndefined();
      expect(useTerminalStore.getState().ptyDataCallbacks['pty-2']).toBe(cb2);
    });

    test('emitPtyData calls the registered callback', () => {
      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', callback);

      useTerminalStore.getState().emitPtyData('pty-1', 'some data');
      expect(callback).toHaveBeenCalledWith('some data');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('emitPtyData does nothing for unregistered ptyId', () => {
      // Should not throw
      useTerminalStore.getState().emitPtyData('nonexistent', 'data');
    });

    test('emitPtyData calls callback multiple times', () => {
      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', callback);

      useTerminalStore.getState().emitPtyData('pty-1', 'chunk-1');
      useTerminalStore.getState().emitPtyData('pty-1', 'chunk-2');
      useTerminalStore.getState().emitPtyData('pty-1', 'chunk-3');

      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback).toHaveBeenNthCalledWith(1, 'chunk-1');
      expect(callback).toHaveBeenNthCalledWith(2, 'chunk-2');
      expect(callback).toHaveBeenNthCalledWith(3, 'chunk-3');
    });

    test('full lifecycle: register, emit, unregister, emit again (no call)', () => {
      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-1', callback);
      useTerminalStore.getState().emitPtyData('pty-1', 'data-1');
      expect(callback).toHaveBeenCalledTimes(1);

      useTerminalStore.getState().unregisterPtyCallback('pty-1');
      useTerminalStore.getState().emitPtyData('pty-1', 'data-2');
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    test('replacing a callback works correctly', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      useTerminalStore.getState().registerPtyCallback('pty-1', cb1);
      useTerminalStore.getState().emitPtyData('pty-1', 'to-cb1');
      expect(cb1).toHaveBeenCalledWith('to-cb1');

      useTerminalStore.getState().registerPtyCallback('pty-1', cb2);
      useTerminalStore.getState().emitPtyData('pty-1', 'to-cb2');
      expect(cb2).toHaveBeenCalledWith('to-cb2');
      expect(cb1).toHaveBeenCalledTimes(1); // cb1 not called again
    });

    test('buffers pty data until a callback is registered', async () => {
      useTerminalStore.getState().emitPtyData('pty-buffered', 'early chunk');

      const callback = vi.fn();
      useTerminalStore.getState().registerPtyCallback('pty-buffered', callback);

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith('early chunk');
      });
    });
  });

  describe('reorderTabs / renameTab / lifecycle helpers', () => {
    test('reorderTabs reorders tabs within a project only', () => {
      const tab1 = makeTab({ id: 'tab-1', projectId: 'p1', label: 'a' });
      const tab2 = makeTab({ id: 'tab-2', projectId: 'p1', label: 'b' });
      const tab3 = makeTab({ id: 'tab-3', projectId: 'p2', label: 'other' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);
      useTerminalStore.getState().addTab(tab3);

      useTerminalStore.getState().reorderTabs('p1', 0, 1);

      const labels = useTerminalStore
        .getState()
        .tabs.filter((t) => t.projectId === 'p1')
        .map((t) => t.label);
      expect(labels).toEqual(['b', 'a']);
    });

    test('renameTab updates the tab label', () => {
      const tab = makeTab({ id: 'tab-1', label: 'old' });
      useTerminalStore.getState().addTab(tab);
      useTerminalStore.getState().renameTab('tab-1', 'new name');
      expect(useTerminalStore.getState().tabs[0].label).toBe('new name');
    });

    test('markAlive and respawnTab clear error state', () => {
      const tab = makeTab({ id: 'tab-1', alive: false, error: 'dead' });
      useTerminalStore.getState().addTab(tab);

      useTerminalStore.getState().markAlive('tab-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(true);
      expect(useTerminalStore.getState().tabs[0].error).toBeUndefined();

      useTerminalStore.getState().setTabError('tab-1', 'spawn failed');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(false);

      useTerminalStore.getState().respawnTab('tab-1');
      expect(useTerminalStore.getState().tabs[0].alive).toBe(true);
      expect(useTerminalStore.getState().tabs[0].restored).toBe(false);
    });

    test('updateCommandMetrics stores metrics by command id', () => {
      useTerminalStore.getState().updateCommandMetrics({
        commandId: 'cmd-1',
        uptime: 42,
        restartCount: 1,
        memoryUsageKB: 512,
      });
      expect(useTerminalStore.getState().commandMetrics['cmd-1']).toEqual({
        uptime: 42,
        restartCount: 1,
        memoryUsageKB: 512,
      });
    });

    test('restoreTabs creates tabs from server sessions', () => {
      useTerminalStore
        .getState()
        .restoreTabs(
          [{ ptyId: 'pty-restored', cwd: '/repo', projectId: 'p1', label: 'main' }],
          [{ id: 'p1', path: '/repo' }],
        );

      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0]).toMatchObject({
        id: 'pty-restored',
        cwd: '/repo',
        restored: true,
      });
      expect(useTerminalStore.getState().sessionsChecked).toBe(true);
    });

    test('markSessionsChecked and resetSessionsChecked toggle flag', () => {
      useTerminalStore.getState().markSessionsChecked();
      expect(useTerminalStore.getState().sessionsChecked).toBe(true);
      useTerminalStore.getState().resetSessionsChecked();
      expect(useTerminalStore.getState().sessionsChecked).toBe(false);
    });
  });
});
