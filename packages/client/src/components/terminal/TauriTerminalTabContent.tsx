import { useEffect, useRef } from 'react';

import {
  attachWebglRenderer,
  createResizeScheduler,
  getTerminalTheme,
  isTauri,
  searchAddonRegistry,
  terminalRegistry,
  useThemeSync,
  writeAndRepaintTerminal,
} from '@/components/terminal/xterm-utils';
import { markMemoryPhase } from '@/lib/memory-phase';
import { cn } from '@/lib/utils';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';

/** Tauri PTY tab — uses xterm.js (lazy-loaded) */
export function TauriTerminalTabContent({
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

  // The effect cleanup cancels the pending RAF and invokes the deferred terminal teardown closure.
  // react-doctor-disable-next-line effect-needs-cleanup
  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

    let cleanup: (() => void) | null = null;
    let isMounted = true;
    let fitFrame: number | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { WebglAddon }] =
        await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-webgl'),
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
      attachWebglRenderer(terminal, WebglAddon);
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
      markMemoryPhase('terminal-open');
      // Re-apply theme after terminal is attached to DOM
      terminal.options.theme = getTerminalTheme();
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        if (isMounted) fitAddon.fit();
      });

      const { invoke } = await import('@tauri-apps/api/core');
      const { listen } = await import('@tauri-apps/api/event');
      if (!isMounted) return;

      const unlistenData = await listen<{ data: string }>(`pty:data:${id}`, (event) => {
        writeAndRepaintTerminal(terminal, event.payload.data, containerRef.current);
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

      const resizeScheduler = createResizeScheduler(() => fitAddon.fit());
      // The deferred cleanup closure disconnects this observer after async terminal setup completes.
      // react-doctor-disable-next-line effect-observer-needs-disconnect
      const resizeObserver = new ResizeObserver(() => resizeScheduler.schedule());
      resizeObserver.observe(containerRef.current!);

      cleanup = () => {
        resizeObserver.disconnect();
        resizeScheduler.dispose();
        unlistenData();
        unlistenExit();
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        searchAddonRegistry.delete(id);
        terminalRegistry.delete(id);
        termRef.current = null;
        // Marked before dispose so the sample still reflects the terminal's cost.
        markMemoryPhase('terminal-close');
        terminal.dispose();
        invoke('pty_kill', { id }).catch(console.error);
      };

      if (!isMounted) {
        cleanup();
      }
    })();

    return () => {
      isMounted = false;
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
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
