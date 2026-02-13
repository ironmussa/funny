import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '@/stores/terminal-store';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import AnsiToHtml from 'ansi-to-html';
import { getActiveWS } from '@/hooks/use-ws';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Square,
  GripHorizontal,
} from 'lucide-react';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown })
  .__TAURI_INTERNALS__;

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

  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

    let cleanup: (() => void) | null = null;

    (async () => {
      // Lazy-load xterm so it doesn't break in browser mode
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // @ts-ignore - CSS import handled by Vite bundler
      await import('@xterm/xterm/css/xterm.css');

      if (!containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: {
          background: '#09090b',
          foreground: '#fafafa',
          cursor: '#fafafa',
          selectionBackground: '#264f78',
        },
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(containerRef.current);
      requestAnimationFrame(() => fitAddon.fit());

      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');

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
        terminal.dispose();
        invoke('pty_kill', { id }).catch(console.error);
      };
    })();

    return () => { cleanup?.(); };
  }, [id, cwd]);

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full', !active && 'hidden')}
    />
  );
}

/** Web PTY tab — uses xterm.js over WebSocket */
function WebTerminalTabContent({
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
  const registerPtyCallback = useTerminalStore(s => s.registerPtyCallback);
  const unregisterPtyCallback = useTerminalStore(s => s.unregisterPtyCallback);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      // Lazy-load xterm
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // @ts-ignore - CSS import handled by Vite bundler
      await import('@xterm/xterm/css/xterm.css');

      // Bail out if the effect was cleaned up while we were loading
      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        theme: {
          background: '#09090b',
          foreground: '#fafafa',
          cursor: '#fafafa',
          selectionBackground: '#264f78',
        },
        convertEol: true,
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

      // Register callback to receive PTY data from WebSocket
      registerPtyCallback(id, (data: string) => {
        terminal.write(data);
      });

      // Send keyboard input to server
      const onDataDisposable = terminal.onData((data) => {
        const ws = getActiveWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty:write', data: { id, data } }));
        }
      });

      // Send resize events to server
      const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
        const ws = getActiveWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pty:resize', data: { id, cols, rows } }));
        }
      });

      // Spawn PTY on server
      const dims = fitAddon.proposeDimensions();
      const ws = getActiveWS();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'pty:spawn',
          data: { id, cwd, rows: dims?.rows ?? 24, cols: dims?.cols ?? 80 },
        }));
      }

      // Auto-resize on container resize
      const resizeObserver = new ResizeObserver(() => {
        if (containerRef.current?.offsetParent !== null) {
          fitAddon.fit();
        }
      });
      resizeObserver.observe(containerRef.current!);

      cleanup = () => {
        resizeObserver.disconnect();
        unregisterPtyCallback(id);
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        termRef.current = null;
        terminal.dispose();

        // Kill PTY on server
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

  // Re-fit and focus when this tab becomes active (fixes canvas corruption
  // caused by xterm being in a display:none container while inactive)
  useEffect(() => {
    if (active && termRef.current) {
      const { terminal, fitAddon } = termRef.current;
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
      });
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className={cn('w-full h-full', !active && 'hidden')}
    />
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

  const ansiConverter = useMemo(() => new AnsiToHtml({ fg: '#fafafa', bg: '#09090b', newline: true, escapeXML: true }), []);
  const htmlOutput = useMemo(() => ansiConverter.toHtml(output || 'Waiting for output...'), [ansiConverter, output]);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output, active]);

  const handleStop = async () => {
    if (projectId) {
      await api.stopCommand(projectId, commandId);
      // ignore errors
    }
  };

  return (
    <div className={cn('w-full h-full flex flex-col', !active && 'hidden')}>
      {alive && (
        <div className="flex items-center justify-end px-2 py-0.5 flex-shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleStop}
                className="text-red-400 hover:text-red-300"
              >
                <Square className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.stop')}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-3 py-1"
      >
        <pre
          className="text-xs font-mono text-[#fafafa] whitespace-pre-wrap break-words leading-relaxed"
          dangerouslySetInnerHTML={{ __html: htmlOutput }}
        />
      </div>
    </div>
  );
}

export function TerminalPanel() {
  const { t } = useTranslation();
  const {
    tabs,
    activeTabId,
    panelVisible,
    addTab,
    removeTab,
    setActiveTab,
    togglePanel,
  } = useTerminalStore();
  const projects = useAppStore(s => s.projects);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);

  const [dragging, setDragging] = useState(false);
  const [panelHeight, setPanelHeight] = useState(300);
  const panelRef = useRef<HTMLDivElement>(null);

  // Filter tabs to only show the current project's terminals
  const visibleTabs = useMemo(
    () => tabs.filter((t) => t.projectId === selectedProjectId),
    [tabs, selectedProjectId]
  );

  // If the active tab isn't in the visible set, pick the last visible one
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
    [panelHeight]
  );

  const handleNewTerminal = useCallback(() => {
    if (!selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    const cwd = project?.path ?? 'C:\\';
    const id = crypto.randomUUID();
    const label = `Terminal ${visibleTabs.length + 1}`;
    addTab({
      id,
      label,
      cwd,
      alive: true,
      projectId: selectedProjectId,
      type: isTauri ? undefined : 'pty',
    });
  }, [projects, selectedProjectId, visibleTabs.length, addTab]);

  const handleCloseTab = useCallback(
    (id: string) => {
      removeTab(id);
    },
    [removeTab]
  );

  // Don't render at all if no tabs and not visible
  if (!panelVisible && !isTauri) return null;

  return (
    <div
      ref={panelRef}
      className={cn(
        'flex flex-col border-t border-border transition-[height] duration-200 ease-out overflow-hidden',
      )}
      style={{ height: panelVisible ? panelHeight : 32 }}
    >
      {/* Drag handle */}
      {panelVisible && (
        <div
          className={cn(
            'flex items-center justify-center h-2 cursor-row-resize hover:bg-primary/20 transition-colors flex-shrink-0 group',
            dragging && 'bg-primary/30'
          )}
          onMouseDown={handleMouseDown}
        >
          <GripHorizontal className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 h-8 bg-secondary/50 border-b border-border flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={togglePanel}>
              {panelVisible ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {panelVisible ? t('terminal.hideTerminal') : t('terminal.showTerminal')}
          </TooltipContent>
        </Tooltip>

        <TerminalIcon className="h-3.5 w-3.5 text-muted-foreground ml-1" />
        <span className="text-xs text-muted-foreground font-medium ml-1">
          {t('terminal.title')}
        </span>

        <div className="flex-1 flex items-center gap-0.5 ml-2 overflow-x-auto">
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
                  : 'text-muted-foreground hover:bg-accent/50'
              )}
            >
              <span>{tab.label}</span>
              {!tab.alive && (
                <span className="text-xs text-yellow-400">{t('terminal.exited')}</span>
              )}
              <X
                className="h-3 w-3 ml-1 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
              />
            </button>
          ))}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleNewTerminal}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Terminal content area */}
      <div className="flex-1 bg-[#09090b] overflow-hidden min-h-0">
        {visibleTabs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
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
              />
            ) : isTauri ? (
              <TauriTerminalTabContent
                key={tab.id}
                id={tab.id}
                cwd={tab.cwd}
                active={tab.id === effectiveActiveTabId}
              />
            ) : null
          )
        )}
      </div>
    </div>
  );
}
