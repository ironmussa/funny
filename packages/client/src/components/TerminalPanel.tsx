import AnsiToHtml from 'ansi-to-html';
import { Plus, X, ChevronDown, Square, Loader2 } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getActiveWS } from '@/hooks/use-ws';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { type TerminalShell, shellLabels, useSettingsStore } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

/** Resolve a CSS variable (HSL) to a hex-like string for xterm/ansi-to-html. */
function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

function getTerminalTheme() {
  return {
    background: getCssVar('--background'),
    foreground: getCssVar('--foreground'),
    cursor: getCssVar('--foreground'),
    selectionBackground: '#264f78',
  };
}

/** Watch for theme changes on <html> class and call back with updated xterm theme. */
function useThemeSync(termRef: React.RefObject<{ terminal: any } | null>) {
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (termRef.current?.terminal) {
        termRef.current.terminal.options.theme = getTerminalTheme();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
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
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);
      termRef.current = { terminal, fitAddon };
      requestAnimationFrame(() => fitAddon.fit());

      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');
      if (!isMounted) return;

      const unlistenData = await listen<{ data: string }>(`pty:data:${id}`, (event) => {
        terminal.write(event.payload.data);
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

  return <div ref={containerRef} className={cn('w-full h-full', !active && 'hidden')} />;
}

/** Web PTY tab — uses xterm.js over WebSocket */
function WebTerminalTabContent({
  id,
  cwd,
  active,
  panelVisible,
  shell: shellOverride,
}: {
  id: string;
  cwd: string;
  active: boolean;
  panelVisible: boolean;
  shell?: TerminalShell;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const registerPtyCallback = useTerminalStore((s) => s.registerPtyCallback);
  const unregisterPtyCallback = useTerminalStore((s) => s.unregisterPtyCallback);
  const [loading, setLoading] = useState(true);
  useThemeSync(termRef);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // @ts-ignore - CSS import handled by Vite bundler
      await import('@xterm/xterm/css/xterm.css');

      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);
      termRef.current = { terminal, fitAddon };
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.focus();
      });

      registerPtyCallback(id, (data: string) => {
        if (!cancelled) setLoading(false);
        terminal.write(data);
      });

      const onDataDisposable = terminal.onData((data) => {
        const ws = getActiveWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty:write', data: { id, data } }));
        }
      });

      const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
        const ws = getActiveWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty:resize', data: { id, cols, rows } }));
        }
      });

      const dims = fitAddon.proposeDimensions();
      const shell = shellOverride ?? useSettingsStore.getState().terminalShell;
      const ws = getActiveWS();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'pty:spawn',
            data: {
              id,
              cwd,
              rows: dims?.rows ?? 24,
              cols: dims?.cols ?? 80,
              ...(shell !== 'default' && { shell }),
            },
          }),
        );
      }

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

      cleanup = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeObserver.disconnect();
        unregisterPtyCallback(id);
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        termRef.current = null;
        terminal.dispose();

        const ws = getActiveWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty:kill', data: { id } }));
        }
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [id, cwd, registerPtyCallback, unregisterPtyCallback]);

  useEffect(() => {
    if (active && panelVisible && termRef.current) {
      const { terminal, fitAddon } = termRef.current;
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
      });
    }
  }, [active, panelVisible]);

  const { t } = useTranslation();

  return (
    <div className={cn('relative w-full h-full', !active && 'hidden')}>
      <div ref={containerRef} className="h-full w-full" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t('terminal.loading')}</span>
          </div>
        </div>
      )}
    </div>
  );
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
    () => ansiConverter.toHtml(output || 'Waiting for output...'),
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
    <div className={cn('w-full h-full flex flex-col', !active && 'hidden')}>
      {alive && (
        <div className="flex flex-shrink-0 items-center justify-end px-2 py-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleStop}
                className="text-status-error hover:text-status-error/80"
              >
                <Square className="h-3 w-3" />
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
  const { tabs, activeTabId, panelVisible, addTab, removeTab, setActiveTab, togglePanel } =
    useTerminalStore(
      useShallow((s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        panelVisible: s.panelVisible,
        addTab: s.addTab,
        removeTab: s.removeTab,
        setActiveTab: s.setActiveTab,
        togglePanel: s.togglePanel,
      })),
    );
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);

  const [dragging, setDragging] = useState(false);
  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT);

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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      const startY = e.clientY;
      const startHeight = panelHeight;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setPanelHeight(Math.max(150, Math.min(startHeight + delta, 600)));
      };

      const onMouseUp = () => {
        setDragging(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [panelHeight],
  );

  const handleNewTerminal = useCallback(
    (shell: TerminalShell) => {
      if (!selectedProjectId) return;
      const project = projects.find((p) => p.id === selectedProjectId);
      const cwd = activeThreadWorktreePath || project?.path || 'C:\\';
      const id = crypto.randomUUID();
      const shellName = shell === 'default' ? 'Terminal' : shellLabels[shell];
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
    [projects, selectedProjectId, visibleTabs, addTab, activeThreadWorktreePath],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      removeTab(id);
    },
    [removeTab],
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
        <div
          className={cn(
            'relative h-1.5 cursor-row-resize flex-shrink-0 after:absolute after:inset-x-0 after:top-1/2 after:h-[1px] after:-translate-y-1/2 after:bg-border after:transition-colors hover:after:bg-sidebar-border',
            dragging && 'after:bg-sidebar-border',
          )}
          onMouseDown={handleMouseDown}
        />

        {/* Tab bar */}
        <div className="flex h-8 flex-shrink-0 items-center gap-0.5 bg-background px-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={togglePanel}>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
          </Tooltip>

          <div className="ml-1 flex flex-1 items-center gap-0.5 overflow-x-auto">
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
              >
                <span>{tab.label}</span>
                {!tab.alive && (
                  <span className="text-xs text-status-pending">{t('terminal.exited')}</span>
                )}
                <X
                  className="ml-1 h-3 w-3 opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                />
              </button>
            ))}
          </div>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" side="top">
              {(Object.keys(shellLabels) as TerminalShell[])
                .filter((key) => key !== 'default')
                .map((shell) => (
                  <DropdownMenuItem key={shell} onClick={() => handleNewTerminal(shell)}>
                    {shellLabels[shell]}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={togglePanel}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
          </Tooltip>
        </div>

        {/* Terminal content area */}
        <div className="min-h-0 flex-1 overflow-hidden bg-background pl-2 pt-5">
          {visibleTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t('terminal.noProcesses')}
            </div>
          ) : (
            tabs.map((tab) =>
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
