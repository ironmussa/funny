import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// getTerminalScope drives which project's terminal the Ctrl+` shortcut targets.
vi.mock('@/hooks/use-terminal-scope', () => ({
  getTerminalScope: vi.fn(() => ({ scopeId: 'p1', scratchThreadId: null })),
  useTerminalScope: vi.fn(() => ({ scopeId: 'p1', scratchThreadId: null })),
}));

import { terminalRegistry } from '@/components/terminal/xterm-utils';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useTerminalStore } from '@/stores/terminal-store';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderShortcuts() {
  return renderHook(() => useGlobalShortcuts(vi.fn(), vi.fn(), vi.fn()), { wrapper });
}

function pressCtrlBacktick() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', ctrlKey: true }));
}

describe('useGlobalShortcuts — Ctrl+` focuses the terminal on open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    terminalRegistry.clear();
    useTerminalStore.setState({ tabs: [], activeTabId: null, panelVisibleByProject: {} });
  });

  test('toggling the panel open places the caret in the active terminal', () => {
    const focus = vi.fn();
    terminalRegistry.set('tab-1', { focus } as never);
    useTerminalStore.setState({
      tabs: [{ id: 'tab-1', label: 'Terminal 1', cwd: '/p1', alive: true, projectId: 'p1' }],
      activeTabId: 'tab-1',
      panelVisibleByProject: { p1: false }, // hidden → Ctrl+` opens it
    });

    renderShortcuts();
    pressCtrlBacktick();

    // Panel is now open and focus is scheduled after the expand animation.
    expect(useTerminalStore.getState().panelVisibleByProject.p1).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('retries focus until the xterm finishes its async (re)creation', () => {
    // Hiding the panel unmounts the dockview terminal, so on reopen the xterm is
    // recreated asynchronously and is NOT yet in the registry at toggle time.
    const focus = vi.fn();
    useTerminalStore.setState({
      tabs: [{ id: 'tab-1', label: 'Terminal 1', cwd: '/p1', alive: true, projectId: 'p1' }],
      activeTabId: 'tab-1',
      panelVisibleByProject: { p1: false },
    });

    renderShortcuts();
    pressCtrlBacktick();

    // Terminal still creating: several retry ticks pass with no focus.
    vi.advanceTimersByTime(250);
    expect(focus).not.toHaveBeenCalled();

    // xterm finishes creating and registers itself; the next retry tick focuses.
    terminalRegistry.set('tab-1', { focus } as never);
    vi.advanceTimersByTime(120);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('stops retrying focus if the panel is hidden again before the xterm mounts', () => {
    const focus = vi.fn();
    useTerminalStore.setState({
      tabs: [{ id: 'tab-1', label: 'Terminal 1', cwd: '/p1', alive: true, projectId: 'p1' }],
      activeTabId: 'tab-1',
      panelVisibleByProject: { p1: false },
    });

    renderShortcuts();
    pressCtrlBacktick(); // opens, starts retrying
    pressCtrlBacktick(); // closes again before the terminal registered

    terminalRegistry.set('tab-1', { focus } as never);
    vi.advanceTimersByTime(500);
    expect(focus).not.toHaveBeenCalled();
  });

  test('toggling the panel closed does not steal focus into the terminal', () => {
    const focus = vi.fn();
    terminalRegistry.set('tab-1', { focus } as never);
    useTerminalStore.setState({
      tabs: [{ id: 'tab-1', label: 'Terminal 1', cwd: '/p1', alive: true, projectId: 'p1' }],
      activeTabId: 'tab-1',
      panelVisibleByProject: { p1: true }, // visible → Ctrl+` hides it
    });

    renderShortcuts();
    pressCtrlBacktick();

    expect(useTerminalStore.getState().panelVisibleByProject.p1).toBe(false);
    vi.advanceTimersByTime(250);
    expect(focus).not.toHaveBeenCalled();
  });
});
