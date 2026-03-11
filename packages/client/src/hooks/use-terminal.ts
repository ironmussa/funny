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

  const getCssVar = (name: string) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : '#1b1b1b';
  };

  const getRawCssVar = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const getTerminalTheme = () => ({
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
  });

  useEffect(() => {
    if (!containerRef.current || !isTauri) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      theme: getTerminalTheme(),
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    // Re-apply theme after terminal is attached to DOM
    terminal.options.theme = getTerminalTheme();

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

  // Handle theme changes (responds to general app theme mutations)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = getTerminalTheme();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return { terminalRef, fitAddonRef };
}
