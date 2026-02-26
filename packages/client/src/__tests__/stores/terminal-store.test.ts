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
      panelVisible: false,
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

    test('has panelVisible false', () => {
      expect(useTerminalStore.getState().panelVisible).toBe(false);
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
      expect(useTerminalStore.getState().tabs[0]).toEqual(tab);
    });

    test('sets the new tab as active', () => {
      const tab = makeTab({ id: 'tab-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().activeTabId).toBe('tab-1');
    });

    test('shows the panel', () => {
      const tab = makeTab({ id: 'tab-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().panelVisible).toBe(true);
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

    test('removing the last tab hides the panel', () => {
      const tab = makeTab({ id: 'tab-1' });
      useTerminalStore.getState().addTab(tab);
      expect(useTerminalStore.getState().panelVisible).toBe(true);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().panelVisible).toBe(false);
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

    test('removing non-last tab keeps panel visible', () => {
      const tab1 = makeTab({ id: 'tab-1' });
      const tab2 = makeTab({ id: 'tab-2' });
      useTerminalStore.getState().addTab(tab1);
      useTerminalStore.getState().addTab(tab2);

      useTerminalStore.getState().removeTab('tab-1');
      expect(useTerminalStore.getState().panelVisible).toBe(true);
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
    test('setPanelVisible sets the value', () => {
      useTerminalStore.getState().setPanelVisible(true);
      expect(useTerminalStore.getState().panelVisible).toBe(true);

      useTerminalStore.getState().setPanelVisible(false);
      expect(useTerminalStore.getState().panelVisible).toBe(false);
    });

    test('togglePanel flips the value', () => {
      expect(useTerminalStore.getState().panelVisible).toBe(false);

      useTerminalStore.getState().togglePanel();
      expect(useTerminalStore.getState().panelVisible).toBe(true);

      useTerminalStore.getState().togglePanel();
      expect(useTerminalStore.getState().panelVisible).toBe(false);
    });

    test('togglePanel works after setPanelVisible', () => {
      useTerminalStore.getState().setPanelVisible(true);
      useTerminalStore.getState().togglePanel();
      expect(useTerminalStore.getState().panelVisible).toBe(false);
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
  });
});
