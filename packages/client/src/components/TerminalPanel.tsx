import AnsiToHtml from 'ansi-to-html';
import { Plus, X, Square, Loader2, AlertCircle, RotateCcw, Zap } from 'lucide-react';
import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getActiveWS } from '@/hooks/use-ws';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { type TerminalShell, useSettingsStore } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

// ── Pre-cache xterm.js modules ──────────────────────────────────────
// Import once on module load so that individual tab mounts don't each
// pay the dynamic-import cost. The promise is shared across all tabs.
let xtermModulesPromise: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
}> | null = null;

function getXtermModules() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      // @ts-ignore - CSS import handled by Vite bundler
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit, webLinks]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      WebLinksAddon: webLinks.WebLinksAddon,
    }));
  }
  return xtermModulesPromise;
}

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
  useThemeSync(termRef);

  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

    let cleanup: (() => void) | null = null;
    let isMounted = true;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // @ts-ignore - CSS import handled by Vite bundler
      await import('@xterm/xterm/css/xterm.css');

      if (!isMounted || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);
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
        terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        useTerminalStore.getState().markExited(id);
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
  }, [id, cwd]);

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
}: {
  id: string;
  cwd: string;
  active: boolean;
  panelVisible: boolean;
  shell?: TerminalShell;
  restored?: boolean;
  projectId?: string;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const registerPtyCallback = useTerminalStore((s) => s.registerPtyCallback);
  const unregisterPtyCallback = useTerminalStore((s) => s.unregisterPtyCallback);
  const tabError = useTerminalStore((s) => s.tabs.find((t) => t.id === id)?.error);
  const tabAlive = useTerminalStore((s) => s.tabs.find((t) => t.id === id)?.alive ?? false);
  const sessionsChecked = useTerminalStore((s) => s.sessionsChecked);
  const [loading, setLoading] = useState(true);
  const [termReady, setTermReady] = useState(false);
  // Track whether we already sent a spawn/restore for this tab to avoid duplicates
  const spawnedRef = useRef(false);
  // Incremented to re-trigger the spawn effect after a failed attempt
  const [spawnAttempt, setSpawnAttempt] = useState(0);
  // Capture whether this tab was freshly created (alive on mount) vs loaded from persistence.
  // Uses getState() to avoid subscribing to alive changes (we only need the initial value).
  const [wasAliveOnMount] = useState(
    () => useTerminalStore.getState().tabs.find((t) => t.id === id)?.alive ?? false,
  );
  useThemeSync(termRef);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const { Terminal, FitAddon, WebLinksAddon } = await getXtermModules();
      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);
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
      setTimeout(() => {
        if (cancelled) return;
        if (!document.querySelector('[role="dialog"][data-state="open"]')) {
          terminal.focus();
        }
      }, 250);

      if (cancelled || !containerRef.current) return;

      // Register the PTY data callback. Any data that arrived before
      // registration (e.g. from an early pty:restore response) is replayed
      // immediately via the store's pending buffer.
      registerPtyCallback(id, (data: string) => {
        if (!cancelled) {
          setLoading(false);
          useTerminalStore.getState().markAlive(id);
        }
        terminal.write(data);
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

      // Bell notification — detect \x07 and show browser notification + tab badge
      const onBellDisposable = terminal.onBell(() => {
        const state = useTerminalStore.getState();
        if (state.activeTabId !== id) {
          state.setBellActive(id);
          if (Notification.permission === 'granted') {
            new Notification('Terminal Bell', {
              body: `Bell in "${label || 'Terminal'}"`,
              tag: `terminal-bell-${id}`,
            });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission();
          }
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

      if (!cancelled) setTermReady(true);

      cleanup = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeObserver.disconnect();
        unregisterPtyCallback(id);
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        onBellDisposable.dispose();
        termRef.current = null;
        terminal.dispose();
        // NOTE: Do NOT send pty:kill here. Component unmount happens on page
        // reload too, which would destroy persistent (tmux) sessions. The kill
        // is sent explicitly when the user closes the tab via handleCloseTab.
      };
    })();

    return () => {
      cancelled = true;
      spawnedRef.current = false;
      setTermReady(false);
      cleanup?.();
    };
  }, [id, cwd, registerPtyCallback, unregisterPtyCallback]);

  // Separate effect for spawn/restore decision — waits for sessionsChecked
  // so that tabs loaded from localStorage don't prematurely spawn a new PTY
  // before the server confirms whether the session still exists.
  // New spawns wait for panelVisible (need real dimensions); restored tabs
  // fire pty:restore immediately (no dimensions needed for history capture).
  useEffect(() => {
    if (spawnedRef.current) return;
    if (!termReady || !termRef.current) return;

    const ws = getActiveWS();

    // Helper: send the spawn/restore message once Socket.IO is connected.
    // If not yet connected, listen for the 'connect' event and retry.
    const sendWhenReady = (send: (ws: any) => void) => {
      if (ws && ws.connected) {
        spawnedRef.current = true;
        send(ws);
      } else if (ws) {
        const onConnect = () => {
          if (spawnedRef.current) return;
          spawnedRef.current = true;
          send(ws);
        };
        ws.once('connect', onConnect);
        return () => ws.off('connect', onConnect);
      }
    };

    if (restored) {
      // Restored tab: server confirmed the session exists.
      // Send pty:restore immediately — no need to wait for panel visibility
      // since we only need the server to capture and send back terminal state.
      // Don't send resize here — dimensions may be wrong if panel is collapsed.
      // The correct resize happens when the user switches to this tab (see
      // the active+panelVisible effect below).
      const cleanup = sendWhenReady((ws: any) => {
        ws.emit('pty:restore', { id });
      });
      // Don't setLoading(false) here — wait for pty:data callback to clear it
      // so the user sees a loading spinner until history actually arrives.
      // Safety timeout: if no data arrives within 3s, clear loading anyway
      // (the session may have no output yet or the capture returned empty).
      const restoreTimeout = setTimeout(() => setLoading(false), 3000);
      return () => {
        cleanup?.();
        clearTimeout(restoreTimeout);
      };
    }

    // For new spawns, wait for panelVisible to get correct dimensions
    if (!panelVisible) return;

    const { fitAddon } = termRef.current;
    // Re-fit now that the panel is visible, then read correct dimensions
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();

    // Use proposed dimensions with sensible fallbacks
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;
    const MIN_COLS = 20;
    const MIN_ROWS = 4;

    if (wasAliveOnMount || sessionsChecked) {
      // Guard against unreasonably small dimensions (container still animating)
      // Only applies to new PTY spawns where correct initial size matters.
      if (cols < MIN_COLS || rows < MIN_ROWS) return;
      // Either a freshly created tab (alive on mount) or the session list
      // was checked and this tab was NOT found — spawn a new PTY.
      let spawnTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = sendWhenReady((ws: any) => {
        ws.emit('pty:spawn', {
          id,
          cwd,
          projectId,
          label,
          rows,
          cols,
          ...(shell !== 'default' && { shell }),
        });
        // If no pty:data arrives within 5s, reset spawnedRef and bump
        // spawnAttempt to re-trigger the effect (runner may not have been
        // connected yet). Give up after 3 attempts.
        spawnTimer = setTimeout(() => {
          const tab = useTerminalStore.getState().tabs.find((t) => t.id === id);
          if (tab && !tab.alive && !tab.error) {
            spawnedRef.current = false;
            setSpawnAttempt((a) => (a < 3 ? a + 1 : a));
          }
        }, 5000);
      });
      return () => {
        cleanup?.();
        if (spawnTimer) clearTimeout(spawnTimer);
      };
    }
  }, [
    termReady,
    panelVisible,
    restored,
    sessionsChecked,
    wasAliveOnMount,
    spawnAttempt,
    id,
    cwd,
    projectId,
    label,
    shell,
  ]);

  useEffect(() => {
    if (active && panelVisible && termRef.current) {
      const { terminal, fitAddon } = termRef.current;
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
        if (!document.querySelector('[role="dialog"][data-state="open"]')) {
          terminal.focus();
        }
      }, 220);
      return () => clearTimeout(timer);
    }
  }, [active, panelVisible, id]);

  const { t } = useTranslation();

  const handleRestart = useCallback(() => {
    // Clear terminal screen
    if (termRef.current?.terminal) {
      termRef.current.terminal.clear();
    }
    // Reset spawn tracking so the spawn effect re-triggers
    spawnedRef.current = false;
    setLoading(true);
    // Mark tab as respawnable (clears error, restored flag)
    useTerminalStore.getState().respawnTab(id);
    // Force the spawn effect to re-run by changing its dependency
    setSpawnAttempt((a) => a + 1);
  }, [id]);

  // Determine if we should show the exited overlay — process died and we're not
  // in initial loading state (which would mean we haven't connected yet)
  const showExited = !tabAlive && !loading && !tabError && sessionsChecked;

  return (
    <div className={cn('absolute inset-0', active ? 'z-10' : 'z-0 invisible pointer-events-none')}>
      <div ref={containerRef} className="h-full w-full bg-background" />
      {tabError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="icon-base flex-shrink-0" />
            <span>{tabError}</span>
          </div>
        </div>
      ) : showExited ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestart}
            className="gap-1.5 text-xs"
            data-testid="terminal-restart"
          >
            <RotateCcw className="icon-xs" />
            {t('terminal.restart', 'Restart')}
          </Button>
        </div>
      ) : loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="icon-base animate-spin" />
            <span>{t('terminal.loading')}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
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
      new AnsiToHtml({
        fg: getCssVar('--foreground'),
        bg: getCssVar('--background'),
        newline: true,
        escapeXML: true,
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

const PANEL_HEIGHT = 300;

export function TerminalPanel() {
  const { t } = useTranslation();
  const {
    tabs,
    activeTabId,
    panelVisible,
    sessionsChecked,
    addTab,
    removeTab,
    setActiveTab,
    togglePanel,
  } = useTerminalStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      panelVisible: s.panelVisible,
      sessionsChecked: s.sessionsChecked,
      addTab: s.addTab,
      removeTab: s.removeTab,
      setActiveTab: s.setActiveTab,
      togglePanel: s.togglePanel,
    })),
  );
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const availableShells = useSettingsStore((s) => s.availableShells);
  const fetchAvailableShells = useSettingsStore((s) => s.fetchAvailableShells);

  useEffect(() => {
    fetchAvailableShells();
  }, [fetchAvailableShells]);

  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
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
      });
    },
    [projects, selectedProjectId, visibleTabs, addTab, activeThreadWorktreePath, availableShells],
  );

  const sendSignal = useCallback((ptyId: string, signal: string) => {
    const ws = getActiveWS();
    if (ws && ws.connected) {
      ws.emit('pty:signal', { id: ptyId, signal });
    }
  }, []);

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
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (!panelVisible) togglePanel();
                }}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap',
                  effectiveActiveTabId === tab.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50',
                )}
                data-testid={`terminal-tab-${tab.id}`}
              >
                {tab.hasBell && effectiveActiveTabId !== tab.id && (
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500"
                    data-testid={`terminal-tab-bell-${tab.id}`}
                  />
                )}
                <span>{tab.label}</span>
                {!tab.alive && (sessionsChecked || !tab.type || tab.type !== 'pty') && (
                  <span className="text-xs text-status-pending">{t('terminal.exited')}</span>
                )}
                <X
                  className="icon-xs ml-1 opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                />
              </button>
            ))}
          </div>

          <DropdownMenu onOpenChange={setDropdownOpen}>
            <Tooltip open={dropdownOpen ? false : tooltipOpen} onOpenChange={setTooltipOpen}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Plus className="icon-sm" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" side="top">
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
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" data-testid="terminal-signal-menu">
                        <Zap className="icon-sm" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('terminal.sendSignal')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" side="top">
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
              <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={togglePanel}>
                <X className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
          </Tooltip>
        </div>

        {/* Terminal content area */}
        <div className="relative m-2 min-h-0 flex-1 overflow-hidden bg-background">
          {visibleTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t('terminal.noProcesses')}
            </div>
          ) : (
            visibleTabs.map((tab) =>
              tab.commandId ? (
                <CommandTabContent
                  key={tab.id}
                  commandId={tab.commandId}
                  projectId={tab.projectId}
                  active={tab.id === effectiveActiveTabId}
                  alive={tab.alive}
                />
              ) : tab.type === 'pty' ? (
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
