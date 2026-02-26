import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { useTerminalStore } from '@/stores/terminal-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

async function getTauriApis() {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return { invoke, listen };
}

interface UseTerminalOptions {
  id: string;
  cwd: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useTerminal({ id, cwd, containerRef }: UseTerminalOptions) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

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

    // Small delay to let the container settle before first fit
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let cleanup: (() => void) | null = null;
    let isMounted = true;

    (async () => {
      const { invoke, listen } = await getTauriApis();
      if (!isMounted) return;

      // Listen for PTY output
      const unlistenData = await listen<{ data: string }>(`pty:data:${id}`, (event) => {
        terminal.write(event.payload.data);
      });

      // Listen for PTY exit
      const unlistenExit = await listen(`pty:exit:${id}`, () => {
        terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        useTerminalStore.getState().markExited(id);
      });

      // Send user input to PTY
      const onDataDisposable = terminal.onData((data) => {
        invoke('pty_write', { id, data }).catch(console.error);
      });

      // Handle resize
      const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
        invoke('pty_resize', { id, rows, cols }).catch(console.error);
      });

      // Spawn the PTY process
      const dims = fitAddon.proposeDimensions();
      const rows = dims?.rows ?? 24;
      const cols = dims?.cols ?? 80;
      await invoke('pty_spawn', { id, cwd, rows, cols });

      cleanup = () => {
        unlistenData();
        unlistenExit();
        onDataDisposable.dispose();
        onResizeDisposable.dispose();
        invoke('pty_kill', { id }).catch(console.error);
      };

      if (!isMounted) {
        cleanup();
      }
    })();

    // ResizeObserver to refit on container size change
    const container = containerRef.current;
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(container);

    return () => {
      isMounted = false;
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      cleanup?.();
    };
  }, [id, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  return { terminalRef, fitAddonRef };
}
