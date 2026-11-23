import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import type { TerminalScope } from '@/hooks/use-terminal-scope';
import type { TerminalTab } from '@/stores/terminal-store';

import { renderWithProviders } from '../helpers/render';

// TerminalPanel: which tabs a scope shows, the tab actions (activate, close,
// kill, rename, signals, new terminal, hide) and the PTY tab lifecycle
// (spawn, exit, restart, error). xterm and the socket are fakes; the panel,
// its tab content components and the terminal store are real.

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// ── Socket ──────────────────────────────────────────────────
const sent: { id: string; command: Record<string, unknown> }[] = [];
const fakeSocket = { connected: true, on: () => {}, off: () => {} };
mock.module('@/hooks/use-ws', () => ({
  useWS: () => {},
  getActiveWS: () => fakeSocket,
  subscribeActiveWS: () => () => {},
  sendTerminalRealtime: (id: string, command: Record<string, unknown>) => {
    sent.push({ id, command });
    return true;
  },
}));

// ── Terminal scope (the project / thread the panel is showing) ──
let scope: TerminalScope = { scopeId: 'p1', scratchThreadId: null, worktreePath: null };
mock.module('@/hooks/use-terminal-scope', () => ({ useTerminalScope: () => scope }));

const opened: { scope: TerminalScope; shell: string }[] = [];
mock.module('@/lib/open-terminal-tab', () => ({
  openScopeTerminal: (s: TerminalScope, shell: string) => opened.push({ scope: s, shell }),
}));

// ── xterm ───────────────────────────────────────────────────
const disposable = { dispose: () => {} };
class FakeTerminal {
  options: Record<string, unknown> = {};
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  write(_data: unknown, cb?: () => void) {
    cb?.();
  }
  onData() {
    return disposable;
  }
  onResize() {
    return disposable;
  }
  onBell() {
    return disposable;
  }
  focus() {}
  reset() {}
  clear() {}
  dispose() {}
}
class FakeFitAddon {
  fit() {}
  proposeDimensions() {
    return { cols: 100, rows: 30 };
  }
}
class FakeAddon {
  dispose() {}
}
mock.module('@/components/terminal/xterm-utils', () => ({
  isTauri: false,
  getXtermModules: () =>
    Promise.resolve({
      Terminal: FakeTerminal,
      FitAddon: FakeFitAddon,
      WebLinksAddon: FakeAddon,
      SearchAddon: FakeAddon,
      WebglAddon: FakeAddon,
    }),
  attachWebglRenderer: () => null,
  createResizeScheduler: () => ({ schedule: () => {}, dispose: () => {} }),
  getCssVar: () => '',
  getTerminalTheme: () => ({}),
  flushPausedRender: () => {},
  repaintVisibleTerminal: () => {},
  refitAndRepaintVisibleTerminal: () => {},
  writeAndRepaintTerminal: () => {},
  searchAddonRegistry: new Map(),
  terminalRegistry: new Map(),
  useThemeSync: () => {},
}));

// Imported after the mocks, which bun does not hoist.
const { TerminalPanel } = await import('@/components/TerminalPanel');
const { useTerminalStore } = await import('@/stores/terminal-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function tab(overrides: Partial<TerminalTab> & Pick<TerminalTab, 'id'>): TerminalTab {
  return {
    label: overrides.id,
    cwd: '/repo',
    alive: true,
    projectId: 'p1',
    type: 'command',
    commandId: `cmd-${overrides.id}`,
    ...overrides,
  };
}

function seed(tabs: TerminalTab[], extra: Record<string, unknown> = {}) {
  useTerminalStore.setState({
    tabs,
    activeTabId: null,
    panelVisibleByProject: { p1: true },
    commandOutput: {},
    commandMetrics: {},
    ptyDataCallbacks: {},
    sessionsChecked: true,
    ...extra,
  });
}

function renderPanel() {
  return renderWithProviders(<TerminalPanel />, { threadId: null });
}

/** The panel's outer wrapper, whose height is 0 while it is hidden. */
function panelRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function closeIcon(tabId: string): Element {
  return screen.getByTestId(`terminal-tab-${tabId}`).querySelector('svg.lucide-x')!;
}

function openMenu(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
}

beforeEach(() => {
  sent.length = 0;
  opened.length = 0;
  scope = { scopeId: 'p1', scratchThreadId: null, worktreePath: null };
  useSettingsStore.setState({
    availableShells: [{ id: 'bash', label: 'Bash', path: '/bin/bash' }],
    fetchAvailableShells: async () => {},
  } as never);
});

describe('TerminalPanel', () => {
  test('shows only the tabs of the active scope, and the empty state when it has none', () => {
    seed([tab({ id: 'a' }), tab({ id: 'b', projectId: 'p2' }), tab({ id: 'c' })]);
    const { container, rerender } = renderPanel();

    expect(screen.getByTestId('terminal-tab-a')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-tab-c')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-tab-b')).toBeNull();
    // With no stored active tab, the last visible tab is the active one.
    expect(screen.getByTestId('terminal-tab-c').classList.contains('bg-accent')).toBe(true);
    expect(panelRoot(container).style.height).toBe('300px');

    // A scope with no tabs (and no stored visibility) is hidden and empty.
    scope = { scopeId: 'p3', scratchThreadId: null, worktreePath: null };
    rerender(<TerminalPanel />);
    expect(screen.queryByTestId('terminal-tab-a')).toBeNull();
    expect(screen.getByText('terminal.noProcesses')).toBeInTheDocument();
    expect(panelRoot(container).style.height).toBe('0px');
  });

  test('an active tab of another scope does not hide this scope’s tabs', () => {
    seed([tab({ id: 'a' }), tab({ id: 'b' }), tab({ id: 'other', projectId: 'p2' })], {
      activeTabId: 'other',
    });
    renderPanel();

    expect(screen.getByTestId('terminal-tab-b').classList.contains('bg-accent')).toBe(true);
    expect(screen.getByTestId('terminal-tab-a').classList.contains('bg-accent')).toBe(false);
  });

  test('clicking a tab activates it, clears its bell and opens a hidden panel', () => {
    seed([tab({ id: 'a', hasBell: true }), tab({ id: 'b' })], {
      activeTabId: 'b',
      panelVisibleByProject: { p1: false },
    });
    const { container } = renderPanel();
    expect(panelRoot(container).style.height).toBe('0px');
    expect(screen.getByTestId('terminal-tab-bell-a')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('terminal-tab-a'));

    const state = useTerminalStore.getState();
    expect(state.activeTabId).toBe('a');
    expect(state.panelVisibleByProject.p1).toBe(true);
    expect(panelRoot(container).style.height).toBe('300px');
    expect(screen.queryByTestId('terminal-tab-bell-a')).toBeNull();
  });

  test('closing a PTY tab kills its session; closing a command tab only removes it', () => {
    seed([tab({ id: 'cmd' }), tab({ id: 'pty', type: 'pty', commandId: undefined })]);
    renderPanel();

    fireEvent.click(closeIcon('pty'));
    expect(sent).toEqual([{ id: 'pty', command: { case: 'close', reason: 'tab-closed' } }]);
    expect(screen.queryByTestId('terminal-tab-pty')).toBeNull();

    sent.length = 0;
    fireEvent.click(closeIcon('cmd'));
    expect(sent).toEqual([]);
    expect(useTerminalStore.getState().tabs).toEqual([]);
    // The last tab of the scope going away hides the panel.
    expect(useTerminalStore.getState().panelVisibleByProject.p1).toBe(false);
  });

  test('the context menu kills a live PTY tab, and offers no kill on an exited one', async () => {
    seed([
      tab({ id: 'live', type: 'pty', commandId: undefined }),
      tab({ id: 'dead', type: 'pty', commandId: undefined, alive: false }),
    ]);
    renderPanel();

    // An exited PTY says so in its tab (sessions are checked).
    expect(
      within(screen.getByTestId('terminal-tab-dead')).getByText('terminal.exited'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('terminal-tab-live')).queryByText('terminal.exited'),
    ).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('terminal-tab-live'));
    fireEvent.click(await screen.findByTestId('terminal-tab-context-kill-live'));
    expect(sent).toContainEqual({ id: 'live', command: { case: 'signal', signal: 'SIGKILL' } });
    // Kill leaves the tab in place: the session's exit marks it exited.
    expect(screen.getByTestId('terminal-tab-live')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.contextMenu(screen.getByTestId('terminal-tab-dead'));
    await screen.findByTestId('terminal-tab-context-close-dead');
    expect(screen.queryByTestId('terminal-tab-context-kill-dead')).toBeNull();
  });

  test('the signal menu sends to the active live PTY tab only', async () => {
    seed([tab({ id: 'pty', type: 'pty', commandId: undefined }), tab({ id: 'cmd' })], {
      activeTabId: 'pty',
    });
    renderPanel();

    openMenu(screen.getByTestId('terminal-signal-menu'));
    fireEvent.click(await screen.findByTestId('terminal-signal-sigint'));
    expect(sent).toContainEqual({ id: 'pty', command: { case: 'signal', signal: 'SIGINT' } });

    // A command tab has no signal menu.
    fireEvent.click(screen.getByTestId('terminal-tab-cmd'));
    expect(screen.queryByTestId('terminal-signal-menu')).toBeNull();
  });

  test('the new-terminal menu opens a terminal in the current scope with the chosen shell', async () => {
    scope = { scopeId: 'p1', scratchThreadId: null, worktreePath: '/repo/.worktrees/t1' };
    seed([]);
    renderPanel();

    const plus = screen
      .getAllByRole('button')
      .find((b) => b.querySelector('svg.lucide-plus')) as HTMLElement;
    openMenu(plus);
    fireEvent.click(await screen.findByTestId('terminal-new-bash'));

    expect(opened).toEqual([{ scope, shell: 'bash' }]);
  });

  test('the hide button toggles the panel of the current scope only', () => {
    seed([tab({ id: 'a' })], { panelVisibleByProject: { p1: true, p2: true } });
    const { container } = renderPanel();

    const hide = screen
      .getAllByRole('button')
      .find((b) => b.classList.contains('ml-auto')) as HTMLElement;
    fireEvent.click(hide);

    expect(useTerminalStore.getState().panelVisibleByProject).toEqual({ p1: false, p2: true });
    expect(panelRoot(container).style.height).toBe('0px');
  });

  test('double-click renames a tab on Enter and keeps the label on Escape', () => {
    seed([tab({ id: 'a', label: 'Bash 1' })]);
    renderPanel();

    fireEvent.doubleClick(screen.getByTestId('terminal-tab-a'));
    const input = screen.getByTestId('terminal-tab-rename-a');
    fireEvent.change(input, { target: { value: '  server  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useTerminalStore.getState().tabs[0].label).toBe('server');

    fireEvent.doubleClick(screen.getByTestId('terminal-tab-a'));
    const again = screen.getByTestId('terminal-tab-rename-a');
    fireEvent.change(again, { target: { value: 'other' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(useTerminalStore.getState().tabs[0].label).toBe('server');
    expect(screen.queryByTestId('terminal-tab-rename-a')).toBeNull();
  });

  test('a new PTY tab spawns its session, and an exited one restarts', async () => {
    seed([tab({ id: 'pty', type: 'pty', commandId: undefined, shell: 'bash', cwd: '/repo/wt' })]);
    renderPanel();

    await waitFor(() => expect(sent.some((s) => s.command.case === 'spawn')).toBe(true));
    expect(sent.filter((s) => s.command.case === 'spawn')).toEqual([
      {
        id: 'pty',
        command: {
          case: 'spawn',
          cwd: '/repo/wt',
          projectId: 'p1',
          label: 'pty',
          rows: 30,
          cols: 100,
          shell: 'bash',
          sandboxThreadId: undefined,
        },
      },
    ]);

    // First output connects the terminal; the session then exits.
    act(() => useTerminalStore.getState().emitPtyData('pty', 'prompt$ '));
    act(() => useTerminalStore.getState().markExited('pty'));
    const restart = await screen.findByTestId('terminal-restart');

    sent.length = 0;
    fireEvent.click(restart);
    expect(useTerminalStore.getState().tabs[0].alive).toBe(true);
    await waitFor(() =>
      expect(sent.flatMap((s) => (s.command.case === 'spawn' ? [s.id] : []))).toEqual(['pty']),
    );
    expect(screen.queryByTestId('terminal-restart')).toBeNull();
  });

  test('a PTY tab with an error shows the error instead of spawning', async () => {
    seed([
      tab({
        id: 'pty',
        type: 'pty',
        commandId: undefined,
        alive: false,
        error: 'Failed to spawn PTY: no such directory',
      }),
    ]);
    renderPanel();

    expect(await screen.findByText('Failed to spawn PTY: no such directory')).toBeInTheDocument();
    expect(sent.filter((s) => s.command.case === 'spawn')).toEqual([]);
  });
});
