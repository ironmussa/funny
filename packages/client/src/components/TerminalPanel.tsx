import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { reorderWithEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/reorder-with-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useMachine } from '@xstate/react';
import { Plus, X, Square, Loader2, AlertCircle, RotateCcw, Zap } from 'lucide-react';
import { useRef, useState, useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { showAgentNotification } from '@/hooks/use-notifications';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { getActiveWS } from '@/hooks/use-ws';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  renderPhaseFromState,
  terminalSpawnMachine,
  type TerminalRenderPhase,
} from '@/machines/terminal-spawn-machine';
import { useProjectStore } from '@/stores/project-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { type TerminalShell, useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';
import { useTerminalStore, type TerminalTab } from '@/stores/terminal-store';
import { useThreadWorktreePath } from '@/stores/thread-context';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

// ── Pre-cache xterm.js modules ──────────────────────────────────────
// Import once on module load so that individual tab mounts don't each
// pay the dynamic-import cost. The promise is shared across all tabs.
let xtermModulesPromise: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
}> | null = null;

function getXtermModules() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-search'),
      // @ts-ignore - CSS import handled by Vite bundler
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit, webLinks, search]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      WebLinksAddon: webLinks.WebLinksAddon,
      SearchAddon: search.SearchAddon,
    }));
  }
  return xtermModulesPromise;
}

// Registry mapping tabId -> SearchAddon instance, populated by terminal tab
// components on mount and cleared on unmount. The search overlay reads from
// this map to drive findNext/findPrevious on the active terminal.
const searchAddonRegistry = new Map<string, import('@xterm/addon-search').SearchAddon>();
const terminalRegistry = new Map<string, import('@xterm/xterm').Terminal>();

// Eagerly start loading xterm modules
if (!isTauri) getXtermModules();

/** Resolve a CSS variable (HSL) to a hex-like string for xterm/ansi-to-html. */
function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

/** Resolve a CSS variable that holds a raw hex value. */
function getRawCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getTerminalTheme() {
  return {
    background: getCssVar('--background'),
    foreground: getCssVar('--foreground'),
    cursor: getCssVar('--foreground'),
    selectionBackground: getRawCssVar('--terminal-selection') || '#264f78',
    scrollbarSliderBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.25)`,
    scrollbarSliderHoverBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.4)`,
    scrollbarSliderActiveBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.5)`,
    black: getRawCssVar('--terminal-black'),
    red: getRawCssVar('--terminal-red'),
    green: getRawCssVar('--terminal-green'),
    yellow: getRawCssVar('--terminal-yellow'),
    blue: getRawCssVar('--terminal-blue'),
    magenta: getRawCssVar('--terminal-magenta'),
    cyan: getRawCssVar('--terminal-cyan'),
    white: getRawCssVar('--terminal-white'),
    brightBlack: getRawCssVar('--terminal-bright-black'),
    brightRed: getRawCssVar('--terminal-bright-red'),
    brightGreen: getRawCssVar('--terminal-bright-green'),
    brightYellow: getRawCssVar('--terminal-bright-yellow'),
    brightBlue: getRawCssVar('--terminal-bright-blue'),
    brightMagenta: getRawCssVar('--terminal-bright-magenta'),
    brightCyan: getRawCssVar('--terminal-bright-cyan'),
    brightWhite: getRawCssVar('--terminal-bright-white'),
  };
}

/** Watch for theme changes on <html> class and call back with updated xterm theme.
 *  Also applies the theme immediately on mount to catch any race with CSS loading. */
function useThemeSync(termRef: React.RefObject<{ terminal: any } | null>) {
  useEffect(() => {
    const applyTheme = () => {
      if (termRef.current?.terminal) {
        termRef.current.terminal.options.theme = getTerminalTheme();
      }
    };
    // Apply immediately in case terminal was created before CSS vars were ready
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, [termRef]);
}

/** Tauri PTY tab — uses xterm.js (lazy-loaded) */
function TauriTerminalTabContent({
  id,
  cwd,
  active,
}: {
  id: string;
  cwd: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const codeFontSizePx = EDITOR_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  useThemeSync(termRef);

  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

    let cleanup: (() => void) | null = null;
    let isMounted = true;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
      ]);
      // @ts-ignore - CSS import handled by Vite bundler
      await import('@xterm/xterm/css/xterm.css');

      if (!isMounted || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: codeFontSizePx,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(searchAddon);
      terminal.open(containerRef.current);
      searchAddonRegistry.set(id, searchAddon);
      terminalRegistry.set(id, terminal);
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('terminal:search-open', { detail: { id } }));
          return false;
        }
        return true;
      });
      termRef.current = { terminal, fitAddon };
      // Re-apply theme after terminal is attached to DOM
      terminal.options.theme = getTerminalTheme();
      requestAnimationFrame(() => fitAddon.fit());

      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');
      if (!isMounted) return;

      const unlistenData = await listen<{ data: string }>(`pty:data:${id}`, (event) => {
        terminal.write(event.payload.data);
        useTerminalStore.getState().markAlive(id);
      });

      const unlistenExit = await listen(`pty:exit:${id}`, () => {
        useTerminalStore.getState().removeTab(id);
      });

      const onDataDisposable = terminal.onData((data) => {
        invoke('pty_write', { id, data }).catch(console.error);
      });

      const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
        invoke('pty_resize', { id, rows, cols }).catch(console.error);
      });

      const dims = fitAddon.proposeDimensions();
      await invoke('pty_spawn', { id, cwd, rows: dims?.rows ?? 24, cols: dims?.cols ?? 80 });

      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(containerRef.current!);

      cleanup = () => {
        resizeObserver.disconnect();
        unlistenData();
        unlistenExit();
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        searchAddonRegistry.delete(id);
        terminalRegistry.delete(id);
        termRef.current = null;
        terminal.dispose();
        invoke('pty_kill', { id }).catch(console.error);
      };

      if (!isMounted) {
        cleanup();
      }
    })();

    return () => {
      isMounted = false;
      cleanup?.();
    };
  }, [id, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync font size when the setting changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.terminal.options.fontSize = codeFontSizePx;
      termRef.current.fitAddon.fit();
    }
  }, [codeFontSizePx]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 bg-background',
        active ? 'z-10' : 'z-0 invisible pointer-events-none',
      )}
    />
  );
}

/** Web PTY tab — uses xterm.js over WebSocket */
function WebTerminalTabContent({
  id,
  cwd,
  active,
  panelVisible,
  shell,
  restored,
  projectId,
  label,
  initialCommand,
}: {
  id: string;
  cwd: string;
  active: boolean;
  panelVisible: boolean;
  shell?: TerminalShell;
  restored?: boolean;
  projectId?: string;
  label?: string;
  initialCommand?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const registerPtyCallback = useTerminalStore((s) => s.registerPtyCallback);
  const unregisterPtyCallback = useTerminalStore((s) => s.unregisterPtyCallback);
  const tabError = useTerminalStore((s) => s.tabs.find((t) => t.id === id)?.error);
  const tabAlive = useTerminalStore((s) => s.tabs.find((t) => t.id === id)?.alive ?? false);
  const sessionsChecked = useTerminalStore((s) => s.sessionsChecked);
  const runnerStatus = useRunnerStatusStore((s) => s.status);
  // Capture whether this tab was freshly created (alive on mount) vs loaded from persistence.
  // Uses getState() to avoid subscribing to alive changes (we only need the initial value).
  const [wasAliveOnMount] = useState(
    () => useTerminalStore.getState().tabs.find((t) => t.id === id)?.alive ?? false,
  );
  // Track whether the initial command (startup commands) was sent to avoid re-sending
  const initialCommandSentRef = useRef(false);
  const prevActiveRef = useRef(active);
  const prevPanelVisibleRef = useRef(panelVisible);
  const codeFontSizePx = EDITOR_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  useThemeSync(termRef);

  // Live-callback refs let the machine's pure actions reach into the latest
  // closure values (id/cwd/label/etc.) without re-instantiating the actor on
  // every render. The machine only knows the action *name*; the body is wired
  // here once via .provide() inside useMemo.
  const emitSpawnRef = useRef<() => void>(() => {});
  const emitRestoreRef = useRef<() => void>(() => {});
  emitSpawnRef.current = () => {
    const ws = getActiveWS();
    if (!ws || !ws.connected || !termRef.current) return;
    const { fitAddon } = termRef.current;
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    const cols = Math.max(dims?.cols ?? 80, 20);
    const rows = Math.max(dims?.rows ?? 24, 4);
    ws.emit('pty:spawn', {
      id,
      cwd,
      projectId,
      label,
      rows,
      cols,
      ...(shell !== 'default' && { shell }),
    });
  };
  emitRestoreRef.current = () => {
    const ws = getActiveWS();
    if (!ws || !ws.connected) return;
    ws.emit('pty:restore', { id });
  };

  const machineWithActions = useMemo(
    () =>
      terminalSpawnMachine.provide({
        actions: {
          emitSpawn: () => emitSpawnRef.current(),
          emitRestore: () => emitRestoreRef.current(),
        },
      }),
    [],
  );

  const [snapshot, send] = useMachine(machineWithActions, {
    input: { restored: !!restored, wasAliveOnMount },
  });

  // Track when the PTY was alive at least once, so a later alive=false flip
  // (server told us the session exited) translates to a single TAB_EXITED
  // event instead of firing on every initial-render with alive=false.
  const everAliveRef = useRef(false);
  useEffect(() => {
    if (tabAlive) {
      everAliveRef.current = true;
    } else if (everAliveRef.current) {
      send({ type: 'TAB_EXITED' });
      everAliveRef.current = false;
    }
  }, [tabAlive, send]);

  // Bridge restored + sessionsChecked together. Order matters: SET_RESTORED
  // must reach the machine *before* SESSIONS_CHECKED, otherwise the
  // awaitingSessionsCheck `always` re-evaluates with restored=false and we
  // take the spawn path while the server already has a live PTY (=> double
  // spawn => black terminal).
  useEffect(() => {
    if (restored) send({ type: 'SET_RESTORED' });
  }, [restored, send]);
  useEffect(() => {
    if (sessionsChecked) send({ type: 'SESSIONS_CHECKED' });
  }, [sessionsChecked, send]);

  useEffect(() => {
    send({ type: 'PANEL_VISIBLE', visible: panelVisible });
  }, [panelVisible, send]);

  useEffect(() => {
    if (tabError) send({ type: 'TAB_ERROR', error: tabError });
  }, [tabError, send]);

  // Bridge socket connection state. Re-fires every time the underlying
  // socket reconnects, so retries during a runner reconnect storm pick up
  // automatically without needing a manual restart.
  useEffect(() => {
    const ws = getActiveWS();
    if (!ws) return;
    const onConnect = () => send({ type: 'SOCKET_CONNECTED', connected: true });
    const onDisconnect = () => send({ type: 'SOCKET_CONNECTED', connected: false });
    ws.on('connect', onConnect);
    ws.on('disconnect', onDisconnect);
    if (ws.connected) send({ type: 'SOCKET_CONNECTED', connected: true });
    return () => {
      ws.off('connect', onConnect);
      ws.off('disconnect', onDisconnect);
    };
  }, [send]);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const { Terminal, FitAddon, WebLinksAddon, SearchAddon } = await getXtermModules();
      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: codeFontSizePx,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(searchAddon);
      terminal.open(containerRef.current);
      searchAddonRegistry.set(id, searchAddon);
      terminalRegistry.set(id, terminal);
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('terminal:search-open', { detail: { id } }));
          return false;
        }
        return true;
      });
      termRef.current = { terminal, fitAddon };

      // Re-apply theme after terminal is attached to DOM, in case CSS vars
      // weren't computed yet when the Terminal was constructed.
      terminal.options.theme = getTerminalTheme();

      // Wait for the terminal to settle dimensions before spawning the PTY.
      // Without this, the shell starts outputting before xterm.js has correct
      // dimensions, causing garbled characters on initial render.
      // Only fit if the container is actually visible — inactive tabs have
      // display:hidden, so fitting would yield tiny dimensions and trigger
      // an onResize with wrong cols, resizing the daemon's headless xterm.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          const el = containerRef.current;
          if (el && el.offsetParent !== null && el.clientHeight > 0) {
            fitAddon.fit();
          }
          resolve();
        });
      });

      // Focus the terminal after a short delay so that any closing dialog
      // (e.g. NewThreadDialog) has time to unmount and the panel expand
      // animation can finish.  Without this, the caret won't appear inside
      // the terminal when it is first created.
      const isNewlyCreated = (() => {
        const cAt = useTerminalStore.getState().tabs.find((t) => t.id === id)?.createdAt;
        return cAt ? Date.now() - cAt < 1000 : false;
      })();
      setTimeout(() => {
        if (cancelled) return;
        if (isNewlyCreated && !document.querySelector('[role="dialog"][data-state="open"]')) {
          terminal.focus();
        }
      }, 250);

      if (cancelled || !containerRef.current) return;

      // Register the PTY data callback. Any data that arrived before
      // registration (e.g. from an early pty:restore response) is replayed
      // immediately via the store's pending buffer.
      registerPtyCallback(id, (data: string) => {
        if (!cancelled) {
          send({ type: 'DATA_RECEIVED' });
          useTerminalStore.getState().markAlive(id);
        }
        terminal.write(data);
        // Auto-execute initial command once the shell is ready (first output = prompt)
        if (!initialCommandSentRef.current && initialCommand) {
          initialCommandSentRef.current = true;
          const ws = getActiveWS();
          if (ws && ws.connected) {
            ws.emit('pty:write', { id, data: initialCommand + '\n' });
          }
        }
      });

      const onDataDisposable = terminal.onData((data) => {
        const ws = getActiveWS();
        if (ws && ws.connected) {
          ws.emit('pty:write', { id, data });
        }
      });

      const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
        // Don't send tiny dimensions to the server — this happens when
        // fitAddon.fit() runs on a hidden (inactive tab) container.
        // Sending these would resize the daemon's headless xterm to a tiny
        // size, causing the shell to wrap output at the wrong width.
        if (cols < 20 || rows < 4) return;
        const ws = getActiveWS();
        if (ws && ws.connected) {
          ws.emit('pty:resize', { id, cols, rows });
        }
      });

      // Bell notification — detect \x07 and set the tab badge. Desktop
      // notification + sound are gated by the user's Settings preferences via
      // showAgentNotification (notificationsEnabled, notificationSoundEnabled).
      const onBellDisposable = terminal.onBell(() => {
        const state = useTerminalStore.getState();
        if (state.activeTabId !== id) {
          state.setBellActive(id);
          showAgentNotification('Terminal Bell', `Bell in "${label || 'Terminal'}"`, {
            tag: `terminal-bell-${id}`,
          });
        }
      });

      // Debounce resize to avoid rapid reflows that cause screen jumping
      let resizeRaf: number | null = null;
      const resizeObserver = new ResizeObserver(() => {
        const el = containerRef.current;
        if (el && el.offsetParent !== null && el.clientHeight > 0) {
          if (resizeRaf) cancelAnimationFrame(resizeRaf);
          resizeRaf = requestAnimationFrame(() => {
            resizeRaf = null;
            fitAddon.fit();
          });
        }
      });
      resizeObserver.observe(containerRef.current!);

      if (!cancelled) send({ type: 'TERM_READY' });

      cleanup = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeObserver.disconnect();
        unregisterPtyCallback(id);
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        onBellDisposable.dispose();
        searchAddonRegistry.delete(id);
        terminalRegistry.delete(id);
        termRef.current = null;
        terminal.dispose();
        // NOTE: Do NOT send pty:kill here. Component unmount happens on page
        // reload too, which would destroy persistent (tmux) sessions. The kill
        // is sent explicitly when the user closes the tab via handleCloseTab.
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- label/initialCommand/codeFontSizePx are intentional one-shot reads at mount; rerunning on change would reset the live xterm
  }, [id, cwd, registerPtyCallback, unregisterPtyCallback]);

  // Sync font size when the setting changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.terminal.options.fontSize = codeFontSizePx;
      termRef.current.fitAddon.fit();
    }
  }, [codeFontSizePx]);

  useEffect(() => {
    if (active && panelVisible && termRef.current) {
      const { terminal, fitAddon } = termRef.current;

      const wasActive = prevActiveRef.current;
      const wasPanelVisible = prevPanelVisibleRef.current;
      const isExplicitTransition = (active && !wasActive) || (panelVisible && !wasPanelVisible);
      const isNewlyCreated = (() => {
        const cAt = useTerminalStore.getState().tabs.find((t) => t.id === id)?.createdAt;
        return cAt ? Date.now() - cAt < 1000 : false;
      })();
      const shouldFocus = isExplicitTransition || isNewlyCreated;

      // Wait for the panel expand animation (200ms) to finish, then fit.
      // This ensures we measure the final container size, not a mid-animation value.
      const timer = setTimeout(() => {
        // Re-sync xterm theme with current CSS variables
        terminal.options.theme = getTerminalTheme();
        fitAddon.fit();
        // Force-send a resize in case fit() didn't trigger onResize
        // (e.g. when dimensions match the stale cached value in xterm).
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          const ws = getActiveWS();
          if (ws && ws.connected) {
            ws.emit('pty:resize', { id, cols: dims.cols, rows: dims.rows });
          }
        }
        terminal.refresh(0, terminal.rows - 1);
        // Only focus if no modal dialog is open (see aria-hidden note above)
        if (shouldFocus && !document.querySelector('[role="dialog"][data-state="open"]')) {
          terminal.focus();
        }
      }, 220);
      return () => clearTimeout(timer);
    }
  }, [active, panelVisible, id]);

  useEffect(() => {
    prevActiveRef.current = active;
    prevPanelVisibleRef.current = panelVisible;
  }, [active, panelVisible]);

  const { t } = useTranslation();

  const handleRestart = useCallback(() => {
    if (termRef.current?.terminal) {
      termRef.current.terminal.clear();
    }
    // Mark tab as respawnable (clears error, restored flag) so the store
    // and machine stay aligned.
    useTerminalStore.getState().respawnTab(id);
    everAliveRef.current = false;
    send({ type: 'RESTART' });
  }, [id, send]);

  const phase: TerminalRenderPhase = renderPhaseFromState(snapshot.value as string, runnerStatus);

  return (
    <div className={cn('absolute inset-0', active ? 'z-10' : 'z-0 invisible pointer-events-none')}>
      <div ref={containerRef} className="size-full bg-background" />
      <TerminalPhaseOverlay phase={phase} error={tabError} onRestart={handleRestart} />
    </div>
  );
}

function TerminalPhaseOverlay({
  phase,
  error,
  onRestart,
}: {
  phase: TerminalRenderPhase;
  error: string | undefined;
  onRestart: () => void;
}) {
  const { t } = useTranslation();

  if (phase === 'error') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="icon-base flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (phase === 'exited') {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRestart}
          className="gap-1.5 text-xs"
          data-testid="terminal-restart"
        >
          <RotateCcw className="icon-xs" />
          {t('terminal.restart', 'Restart')}
        </Button>
      </div>
    );
  }

  if (phase === 'awaiting-runner') {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-background"
        data-testid="terminal-awaiting-runner"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="icon-base animate-spin" />
          <span>{t('terminal.awaitingRunner', 'Waiting for runner to come online…')}</span>
        </div>
      </div>
    );
  }

  if (
    phase === 'initializing' ||
    phase === 'awaiting-sessions' ||
    phase === 'spawning' ||
    phase === 'restoring'
  ) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="icon-base animate-spin" />
          <span>{t('terminal.loading')}</span>
        </div>
      </div>
    );
  }

  // 'connected' — no overlay
  return null;
}

/** Format milliseconds as human-readable uptime */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Server-managed command tab — uses a <pre> log view */
function CommandTabContent({
  commandId,
  projectId,
  active,
  alive,
}: {
  commandId: string;
  projectId?: string;
  active: boolean;
  alive: boolean;
}) {
  const { t } = useTranslation();
  const output = useTerminalStore((s) => s.commandOutput[commandId] ?? '');
  const metrics = useTerminalStore((s) => s.commandMetrics[commandId]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ansiConverter = useMemo(
    () =>
      createAnsiConverter({
        fg: getCssVar('--foreground'),
        bg: getCssVar('--background'),
        newline: true,
      }),
    [],
  );

  const htmlOutput = useMemo(
    () => (output ? ansiConverter.toHtml(output) : 'Waiting for output...'),
    [ansiConverter, output],
  );

  useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output, active]);

  const handleStop = async () => {
    if (projectId) {
      await api.stopCommand(projectId, commandId);
    }
  };

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col bg-background',
        active ? 'z-10' : 'z-0 invisible pointer-events-none',
      )}
    >
      {alive && (
        <div className="flex flex-shrink-0 items-center gap-3 px-2 py-0.5">
          {metrics && (
            <div
              className="flex items-center gap-3 text-[10px] text-muted-foreground"
              data-testid="command-metrics"
            >
              <span>
                {t('terminal.uptime')}: {formatUptime(metrics.uptime)}
              </span>
              <span>
                {t('terminal.memory')}: {(metrics.memoryUsageKB / 1024).toFixed(1)} MB
              </span>
              {metrics.restartCount > 0 && (
                <span className="text-yellow-500">
                  {t('terminal.restarts')}: {metrics.restartCount}
                </span>
              )}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleStop}
                className="ml-auto text-status-error hover:text-status-error/80"
                data-testid="command-stop"
              >
                <Square className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.stop')}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-1">
        <pre
          className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[#fafafa]"
          dangerouslySetInnerHTML={{ __html: htmlOutput }}
        />
      </div>
    </div>
  );
}

/** Search overlay shown over the active terminal when the user presses Ctrl+F. */
function TerminalSearchOverlay({
  activeTabId,
  onClose,
}: {
  activeTabId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refocus the input when Ctrl+F is pressed again while the overlay is open
  // (e.g. focus was lost to the terminal or another element).
  useEffect(() => {
    const focus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    window.addEventListener('terminal:search-focus', focus);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('terminal:search-focus', focus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const decorations = useMemo(
    () => ({
      matchBorder: '#ffd900',
      activeMatchBorder: '#ff9900',
      matchOverviewRuler: '#ffd900',
      activeMatchColorOverviewRuler: '#ff9900',
    }),
    [],
  );

  useEffect(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon) return;
    const dispose = addon.onDidChangeResults((res) => setResult(res));
    return () => dispose.dispose();
  }, [activeTabId]);

  // Re-run search incrementally on query/option changes
  useEffect(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setResult(null);
      return;
    }
    addon.findNext(query, {
      caseSensitive,
      wholeWord,
      regex,
      decorations,
      incremental: true,
    });
  }, [query, caseSensitive, wholeWord, regex, activeTabId, decorations]);

  const findNext = useCallback(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon || !query) return;
    addon.findNext(query, { caseSensitive, wholeWord, regex, decorations });
  }, [activeTabId, query, caseSensitive, wholeWord, regex, decorations]);

  const findPrev = useCallback(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon || !query) return;
    addon.findPrevious(query, { caseSensitive, wholeWord, regex, decorations });
  }, [activeTabId, query, caseSensitive, wholeWord, regex, decorations]);

  const totalMatches = result?.resultCount ?? 0;
  const currentIndex = result && result.resultCount > 0 ? result.resultIndex : undefined;

  return (
    <SearchBar
      key={activeTabId}
      inputRef={inputRef}
      query={query}
      onQueryChange={setQuery}
      totalMatches={totalMatches}
      currentIndex={currentIndex}
      onPrev={findPrev}
      onNext={findNext}
      onClose={onClose}
      placeholder={t('terminal.searchPlaceholder', 'Find')}
      showIcon={false}
      testIdPrefix="terminal-search"
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={setCaseSensitive}
      wholeWord={wholeWord}
      onWholeWordChange={setWholeWord}
      regex={regex}
      onRegexChange={setRegex}
      className="absolute right-3 top-2 z-20 w-[26rem] rounded-md border bg-popover px-1.5 py-1 shadow-md"
    />
  );
}

const PANEL_HEIGHT = 300;

const TAB_DRAG_TYPE = 'terminal-tab';

interface DraggableTerminalTabProps {
  tab: TerminalTab;
  index: number;
  active: boolean;
  sessionsChecked: boolean;
  onActivate: () => void;
  onClose: () => void;
  onKill: () => void;
  onRename: (label: string) => void;
}

function DraggableTerminalTab({
  tab,
  index,
  active,
  sessionsChecked,
  onActivate,
  onClose,
  onKill,
  onRename,
}: DraggableTerminalTabProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(tab.label);

  const startRename = useCallback(() => {
    setDraftLabel(tab.label);
    setIsEditing(true);
  }, [tab.label]);

  const commitRename = useCallback(() => {
    const trimmed = draftLabel.trim();
    if (trimmed && trimmed !== tab.label) onRename(trimmed);
    setIsEditing(false);
  }, [draftLabel, tab.label, onRename]);

  const cancelRename = useCallback(() => {
    setDraftLabel(tab.label);
    setIsEditing(false);
  }, [tab.label]);

  const onOutsidePointerDown = useEffectEvent((event: PointerEvent) => {
    const input = inputRef.current;
    if (!input) return;
    if (event.target instanceof Node && input.contains(event.target)) return;
    cancelRename();
  });

  useEffect(() => {
    if (!isEditing) return;
    const handlePointerDown = (event: PointerEvent) => onOutsidePointerDown(event);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isEditing]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({
          type: TAB_DRAG_TYPE,
          tabId: tab.id,
          projectId: tab.projectId,
          index,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          source.data.type === TAB_DRAG_TYPE && source.data.projectId === tab.projectId,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: TAB_DRAG_TYPE, tabId: tab.id, projectId: tab.projectId, index },
            { input, element, allowedEdges: ['left', 'right'] },
          ),
        getIsSticky: () => true,
        onDrag: ({ self, source }) => {
          if (source.data.tabId === tab.id) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [tab.id, tab.projectId, index]);

  const isPty = tab.type === 'pty';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={ref}
          onClick={onActivate}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
          className={cn(
            'relative flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap',
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50',
            isDragging && 'opacity-40',
          )}
          data-testid={`terminal-tab-${tab.id}`}
        >
          {tab.hasBell && !active && (
            <span
              className="size-1.5 animate-pulse rounded-full bg-yellow-500"
              data-testid={`terminal-tab-bell-${tab.id}`}
            />
          )}
          {isEditing ? (
            <Input
              ref={inputRef}
              autoFocus
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 w-32 px-1 py-0 text-xs"
              data-testid={`terminal-tab-rename-${tab.id}`}
            />
          ) : (
            <span>{tab.label}</span>
          )}
          {!tab.alive && (sessionsChecked || !tab.type || tab.type !== 'pty') && (
            <span className="text-xs text-status-pending">{t('terminal.exited')}</span>
          )}
          <X
            className="icon-xs ml-1 opacity-60 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          />
          {closestEdge && (
            <span
              className={cn(
                'pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary',
                closestEdge === 'left' ? '-left-px' : '-right-px',
              )}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => startRename()}
          data-testid={`terminal-tab-context-rename-${tab.id}`}
        >
          {t('terminal.rename')}
        </ContextMenuItem>
        {isPty && tab.alive && (
          <ContextMenuItem
            onSelect={() => onKill()}
            className="text-destructive focus:text-destructive"
            data-testid={`terminal-tab-context-kill-${tab.id}`}
          >
            {t('terminal.kill')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onClose()}
          data-testid={`terminal-tab-context-close-${tab.id}`}
        >
          {t('terminal.close')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// eslint-disable-next-line max-lines-per-function -- top-level panel; further extraction tracked separately
export function TerminalPanel() {
  const { t } = useTranslation();
  const {
    tabs,
    activeTabId,
    panelVisibleByProject,
    sessionsChecked,
    addTab,
    removeTab,
    reorderTabs,
    renameTab,
    setActiveTab,
    togglePanel,
  } = useTerminalStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      panelVisibleByProject: s.panelVisibleByProject,
      sessionsChecked: s.sessionsChecked,
      addTab: s.addTab,
      removeTab: s.removeTab,
      reorderTabs: s.reorderTabs,
      renameTab: s.renameTab,
      setActiveTab: s.setActiveTab,
      togglePanel: s.togglePanel,
    })),
  );
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const panelVisible = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false)
    : false;
  const activeThreadWorktreePath = useThreadWorktreePath();
  const availableShells = useSettingsStore((s) => s.availableShells);
  const fetchAvailableShells = useSettingsStore((s) => s.fetchAvailableShells);

  useEffect(() => {
    fetchAvailableShells();
  }, [fetchAvailableShells]);

  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT);
  const [searchVisible, setSearchVisible] = useState(false);
  const newTermMenu = useTooltipMenu();
  const signalMenu = useTooltipMenu();
  const startHeight = useRef(panelHeight);

  const {
    resizing: dragging,
    handlePointerDown: handleDragPointerDown,
    handlePointerMove: handleDragPointerMove,
    handlePointerUp: handleDragPointerUp,
  } = useResizeHandle({
    direction: 'vertical',
    onResizeStart: () => {
      startHeight.current = panelHeight;
    },
    onResize: (deltaPx) => {
      // Dragging up (negative delta) increases height
      setPanelHeight(Math.max(150, Math.min(startHeight.current - deltaPx, 600)));
    },
  });

  const visibleTabs = useMemo(
    () => tabs.filter((t) => t.projectId === selectedProjectId),
    [tabs, selectedProjectId],
  );

  const effectiveActiveTabId = useMemo(() => {
    if (activeTabId && visibleTabs.some((t) => t.id === activeTabId)) {
      return activeTabId;
    }
    return visibleTabs[visibleTabs.length - 1]?.id ?? null;
  }, [activeTabId, visibleTabs]);

  const handleNewTerminal = useCallback(
    (shell: TerminalShell) => {
      if (!selectedProjectId) return;
      const project = projects.find((p) => p.id === selectedProjectId);
      const cwd = activeThreadWorktreePath || project?.path || 'C:\\';
      const id = crypto.randomUUID();
      const detected = availableShells.find((s) => s.id === shell);
      const shellName = detected?.label ?? 'Terminal';
      const sameShellCount = visibleTabs.filter((t) => (t.shell ?? 'default') === shell).length;
      const label = `${shellName} ${sameShellCount + 1}`;
      addTab({
        id,
        label,
        cwd,
        alive: true,
        projectId: selectedProjectId,
        type: isTauri ? undefined : 'pty',
        shell,
        createdAt: Date.now(),
      });
      // Panel must be visible for the spawn effect to emit pty:spawn
      // (see !panelVisible guard in XtermTerminal). Auto-expand if collapsed.
      if (!panelVisible) togglePanel(selectedProjectId);
    },
    [
      projects,
      selectedProjectId,
      visibleTabs,
      addTab,
      activeThreadWorktreePath,
      availableShells,
      panelVisible,
      togglePanel,
    ],
  );

  const sendSignal = useCallback((ptyId: string, signal: string) => {
    const ws = getActiveWS();
    if (ws && ws.connected) {
      ws.emit('pty:signal', { id: ptyId, signal });
    }
  }, []);

  // Open the search overlay when a terminal forwards Ctrl+F via custom event
  useEffect(() => {
    const handler = () => setSearchVisible(true);
    window.addEventListener('terminal:search-open', handler);
    return () => window.removeEventListener('terminal:search-open', handler);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    if (effectiveActiveTabId) {
      const addon = searchAddonRegistry.get(effectiveActiveTabId);
      addon?.clearDecorations();
      terminalRegistry.get(effectiveActiveTabId)?.focus();
    }
  }, [effectiveActiveTabId]);

  // Close search when the active tab changes
  useEffect(() => {
    setSearchVisible(false);
  }, [effectiveActiveTabId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    return monitorForElements({
      canMonitor: ({ source }) =>
        source.data.type === TAB_DRAG_TYPE && source.data.projectId === selectedProjectId,
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        if (target.data.type !== TAB_DRAG_TYPE) return;
        if (target.data.projectId !== selectedProjectId) return;
        if (source.data.tabId === target.data.tabId) return;

        const startIndex = source.data.index as number;
        const indexOfTarget = target.data.index as number;
        const closestEdgeOfTarget = extractClosestEdge(target.data);

        const currentOrder = useTerminalStore
          .getState()
          .tabs.filter((t) => t.projectId === selectedProjectId)
          .map((t) => t.id);
        const reordered = reorderWithEdge({
          list: currentOrder,
          startIndex,
          indexOfTarget,
          closestEdgeOfTarget,
          axis: 'horizontal',
        });
        const finishIndex = reordered.indexOf(source.data.tabId as string);
        if (finishIndex === startIndex) return;
        reorderTabs(selectedProjectId, startIndex, finishIndex);
      },
    });
  }, [selectedProjectId, reorderTabs]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      // Send pty:kill for interactive PTY tabs (user explicitly closing)
      if (tab?.type === 'pty') {
        const ws = getActiveWS();
        if (ws && ws.connected) {
          ws.emit('pty:kill', { id: tabId });
        }
      }
      removeTab(tabId);
    },
    [tabs, removeTab],
  );

  const handleKillTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.type !== 'pty') return;
      const ws = getActiveWS();
      if (ws && ws.connected) {
        ws.emit('pty:signal', { id: tabId, signal: 'SIGKILL' });
      }
    },
    [tabs],
  );

  return (
    <div
      className={cn(
        'flex-shrink-0 overflow-hidden',
        !dragging && 'transition-[height] duration-200 ease-in-out',
      )}
      style={{
        height: panelVisible ? panelHeight : 0,
      }}
    >
      {/* Inner wrapper always keeps full height so xterm terminals preserve their buffer */}
      <div className="flex flex-col bg-background" style={{ height: panelHeight }}>
        {/* Drag handle — matches sidebar rail style */}
        <ResizeHandle
          direction="vertical"
          resizing={dragging}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
        />

        {/* Tab bar */}
        <div className="flex h-8 flex-shrink-0 items-center gap-0.5 bg-background px-2">
          <div className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {visibleTabs.map((tab, index) => (
              <DraggableTerminalTab
                key={tab.id}
                tab={tab}
                index={index}
                active={effectiveActiveTabId === tab.id}
                sessionsChecked={sessionsChecked}
                onActivate={() => {
                  setActiveTab(tab.id);
                  if (!panelVisible && selectedProjectId) togglePanel(selectedProjectId);
                }}
                onClose={() => handleCloseTab(tab.id)}
                onKill={() => handleKillTab(tab.id)}
                onRename={(label) => renameTab(tab.id, label)}
              />
            ))}
          </div>

          <DropdownMenu {...newTermMenu.menuProps}>
            <Tooltip {...newTermMenu.tooltipProps}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Plus className="icon-sm" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" side="top" {...newTermMenu.contentProps}>
              {availableShells.map((shell) => (
                <DropdownMenuItem
                  key={shell.id}
                  onClick={() => handleNewTerminal(shell.id)}
                  data-testid={`terminal-new-${shell.id}`}
                >
                  {shell.label}
                </DropdownMenuItem>
              ))}
              {availableShells.length === 0 && (
                <DropdownMenuItem onClick={() => handleNewTerminal('default')}>
                  {t('settings.shellDefault')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {effectiveActiveTabId &&
            visibleTabs.find((t) => t.id === effectiveActiveTabId)?.alive &&
            visibleTabs.find((t) => t.id === effectiveActiveTabId)?.type === 'pty' && (
              <DropdownMenu {...signalMenu.menuProps}>
                <Tooltip {...signalMenu.tooltipProps}>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" data-testid="terminal-signal-menu">
                        <Zap className="icon-sm" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('terminal.sendSignal')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" side="top" {...signalMenu.contentProps}>
                  <DropdownMenuItem
                    onClick={() => sendSignal(effectiveActiveTabId, 'SIGINT')}
                    data-testid="terminal-signal-sigint"
                  >
                    SIGINT (Ctrl+C)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => sendSignal(effectiveActiveTabId, 'SIGTERM')}
                    data-testid="terminal-signal-sigterm"
                  >
                    SIGTERM
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => sendSignal(effectiveActiveTabId, 'SIGKILL')}
                    className="text-destructive"
                    data-testid="terminal-signal-sigkill"
                  >
                    SIGKILL (Force)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                onClick={() => selectedProjectId && togglePanel(selectedProjectId)}
              >
                <X className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
          </Tooltip>
        </div>

        {/* Terminal content area */}
        <div className="relative m-2 min-h-0 flex-1 overflow-hidden bg-background">
          {searchVisible && effectiveActiveTabId && (
            <TerminalSearchOverlay activeTabId={effectiveActiveTabId} onClose={closeSearch} />
          )}
          {visibleTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t('terminal.noProcesses')}
            </div>
          ) : (
            visibleTabs.map((tab) =>
              tab.type === 'pty' ? (
                <WebTerminalTabContent
                  key={tab.id}
                  id={tab.id}
                  cwd={tab.cwd}
                  active={tab.id === effectiveActiveTabId}
                  panelVisible={panelVisible}
                  shell={tab.shell}
                  restored={tab.restored}
                  projectId={tab.projectId}
                  label={tab.label}
                  initialCommand={tab.initialCommand}
                />
              ) : tab.commandId ? (
                <CommandTabContent
                  key={tab.id}
                  commandId={tab.commandId}
                  projectId={tab.projectId}
                  active={tab.id === effectiveActiveTabId}
                  alive={tab.alive}
                />
              ) : isTauri ? (
                <TauriTerminalTabContent
                  key={tab.id}
                  id={tab.id}
                  cwd={tab.cwd}
                  active={tab.id === effectiveActiveTabId}
                />
              ) : null,
            )
          )}
        </div>
      </div>
    </div>
  );
}
