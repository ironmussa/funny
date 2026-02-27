import AnsiToHtml from 'ansi-to-html';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  ChevronDown,
  Square,
  GripHorizontal,
} from 'lucide-react';
import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getActiveWS } from '@/hooks/use-ws';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

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
        theme: {
          background: '#09090b',
          foreground: '#fafafa',
          cursor: '#fafafa',
          selectionBackground: '#264f78',
        },
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
function WebTerminalTabContent({ id, cwd, active }: { id: string; cwd: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const registerPtyCallback = useTerminalStore((s) => s.registerPtyCallback);
  const unregisterPtyCallback = useTerminalStore((s) => s.unregisterPtyCallback);

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
        theme: {
          background: '#09090b',
          foreground: '#fafafa',
          cursor: '#fafafa',
          selectionBackground: '#264f78',
        },
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
      const shell = useSettingsStore.getState().terminalShell;
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
        if (containerRef.current?.offsetParent !== null) {
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
    if (active && termRef.current) {
      const { terminal, fitAddon } = termRef.current;
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
      });
    }
  }, [active]);

  return <div ref={containerRef} className={cn('w-full h-full', !active && 'hidden')} />;
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
    () => new AnsiToHtml({ fg: '#fafafa', bg: '#09090b', newline: true, escapeXML: true }),
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
    [removeTab],
  );

  if (!panelVisible && !isTauri) return null;

  return (
    <div
      className="flex flex-shrink-0 flex-col overflow-hidden border-t border-border bg-background"
      style={{
        height: panelVisible ? panelHeight : 0,
      }}
    >
      {/* Drag handle */}
      <div
        className={cn(
          'flex items-center justify-center h-2 cursor-row-resize hover:bg-primary/20 transition-colors flex-shrink-0 group',
          dragging && 'bg-primary/30',
        )}
        onMouseDown={handleMouseDown}
      >
        <GripHorizontal className="h-3 w-3 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/70" />
      </div>

      {/* Tab bar */}
      <div className="flex h-8 flex-shrink-0 items-center gap-0.5 border-b border-border bg-secondary/50 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={togglePanel}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
        </Tooltip>

        <TerminalIcon className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        <span className="ml-1 text-xs font-medium text-muted-foreground">
          {t('terminal.title')}
        </span>

        <div className="ml-2 flex flex-1 items-center gap-0.5 overflow-x-auto">
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

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={handleNewTerminal}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Terminal content area */}
      <div className="min-h-0 flex-1 overflow-hidden bg-[#09090b]">
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
  );
}
