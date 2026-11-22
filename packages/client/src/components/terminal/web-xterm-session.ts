import type { RefObject } from 'react';

import {
  attachWebglRenderer,
  createResizeScheduler,
  getTerminalTheme,
  getXtermModules,
  refitAndRepaintVisibleTerminal,
  repaintVisibleTerminal,
  searchAddonRegistry,
  terminalRegistry,
} from '@/components/terminal/xterm-utils';
import { showAgentNotification } from '@/hooks/use-notifications';
import { sendTerminalRealtime } from '@/hooks/use-ws';
import { markMemoryPhase } from '@/lib/memory-phase';
import { useTerminalStore } from '@/stores/terminal-store';

type TerminalStoreState = ReturnType<typeof useTerminalStore.getState>;

export interface WebXtermSessionOptions {
  id: string;
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<{ terminal: any; fitAddon: any } | null>;
  /** Font size at mount; later changes are applied by the component. */
  fontSize: number;
  label?: string;
  initialCommand?: string;
  /** Set once the initial command has been written, so it is never sent twice. */
  initialCommandSentRef: RefObject<boolean>;
  send: (event: { type: 'DATA_RECEIVED' } | { type: 'TERM_READY' }) => void;
  registerPtyCallback: TerminalStoreState['registerPtyCallback'];
  unregisterPtyCallback: TerminalStoreState['unregisterPtyCallback'];
}

/**
 * Mount a web PTY tab's xterm.js terminal in `containerRef` and wire it to the
 * realtime PTY stream. Returns the teardown for the component's mount effect.
 */
export function mountWebXterm(options: WebXtermSessionOptions): () => void {
  const {
    id,
    containerRef,
    termRef,
    fontSize: codeFontSizePx,
    label,
    initialCommand,
    initialCommandSentRef,
    send,
    registerPtyCallback,
    unregisterPtyCallback,
  } = options;

  let cancelled = false;
  let cleanup: (() => void) | null = null;
  let focusTimeout: ReturnType<typeof setTimeout> | undefined;
  let settleFrame: number | null = null;
  let resolveSettleFrame: (() => void) | null = null;
  // Coalesced repaint kick. The WebGL renderer can leave the canvas frozen
  // on the live hot path — writes land in the buffer but the framebuffer
  // isn't flushed until an unrelated resize/refresh (e.g. a tab switch),
  // which is why typed input only appears after switching threads. Forcing a
  // single refresh on the next animation frame after a write batch reflushes
  // the canvas without per-chunk thrash.
  //
  // Two distinct failure modes are covered here, in order:
  //   1. xterm's RenderService is *paused*. When the terminal sits in an
  //      inactive dockview tab (display:none) its IntersectionObserver pauses
  //      all rendering; after a tab/thread switch it can be left stuck paused
  //      on a terminal that is actually visible. While paused `refresh()` is a
  //      no-op (it only flags a pending flush), so we first drive xterm's own
  //      un-pause path via flushPausedRender — but only when on screen, never
  //      waking a genuinely hidden terminal.
  //   2. Renderer is live but the canvas didn't composite the latest write
  //      (stale framebuffer). A plain refresh reflushes it.
  let repaintScheduled = false;
  let repaintFrame: number | null = null;
  const scheduleRepaint = (terminal: import('@xterm/xterm').Terminal) => {
    if (repaintScheduled) return;
    repaintScheduled = true;
    repaintFrame = requestAnimationFrame(() => {
      repaintFrame = null;
      repaintScheduled = false;
      if (cancelled) return;
      repaintVisibleTerminal(terminal, containerRef.current);
    });
  };

  (async () => {
    const { Terminal, FitAddon, WebLinksAddon, SearchAddon, WebglAddon } = await getXtermModules();
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

    // Phase boundary for a memory profiling run: xterm buffers and the WebGL
    // renderer are now live. No-op unless a run is active.
    markMemoryPhase('terminal-open');

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
      resolveSettleFrame = resolve;
      settleFrame = requestAnimationFrame(() => {
        settleFrame = null;
        resolveSettleFrame = null;
        const el = containerRef.current;
        if (el && el.offsetParent !== null && el.clientHeight > 0) {
          fitAddon.fit();
        }
        resolve();
      });
    });

    if (cancelled || !containerRef.current) {
      searchAddonRegistry.delete(id);
      terminalRegistry.delete(id);
      termRef.current = null;
      markMemoryPhase('terminal-close');
      terminal.dispose();
      return;
    }

    // Focus the terminal after a short delay so that any closing dialog
    // (e.g. NewThreadDialog) has time to unmount and the panel expand
    // animation can finish.  Without this, the caret won't appear inside
    // the terminal when it is first created.
    const isNewlyCreated = (() => {
      const cAt = useTerminalStore.getState().tabs.find((t) => t.id === id)?.createdAt;
      return cAt ? Date.now() - cAt < 1000 : false;
    })();
    focusTimeout = setTimeout(() => {
      if (cancelled) return;
      if (isNewlyCreated && !document.querySelector('[role="dialog"][data-state="open"]')) {
        terminal.focus();
      }
    }, 250);

    // Register the PTY data callback. Any data that arrived before
    // registration (e.g. from an early pty:restore response) is replayed
    // immediately via the store's pending buffer.
    registerPtyCallback(id, (data) => {
      if (!cancelled) {
        send({ type: 'DATA_RECEIVED' });
        useTerminalStore.getState().markAlive(id);
      }
      // terminal.write accepts both string and Uint8Array natively. Schedule
      // repaint from the write callback so restored buffers paint after xterm
      // has processed the chunk, not one frame too early.
      terminal.write(data, () => scheduleRepaint(terminal));
      // Auto-execute initial command once the shell is ready (first output = prompt)
      if (!initialCommandSentRef.current && initialCommand) {
        initialCommandSentRef.current = true;
        sendTerminalRealtime(id, { case: 'write', data: initialCommand + '\n' });
      }
    });

    const onDataDisposable = terminal.onData((data) => {
      sendTerminalRealtime(id, { case: 'write', data });
    });

    const onResizeDisposable = terminal.onResize(({ rows, cols }) => {
      // Don't send tiny dimensions to the server — this happens when
      // fitAddon.fit() runs on a hidden (inactive tab) container.
      // Sending these would resize the daemon's headless xterm to a tiny
      // size, causing the shell to wrap output at the wrong width.
      if (cols < 20 || rows < 4) return;
      sendTerminalRealtime(id, { case: 'resize', cols, rows });
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

    // Trailing-debounced fit (see createResizeScheduler): coalesces frame
    // storms from dockview splitter drags, window resize, and the bottom
    // panel transition into one fit on settle — avoids WebGL canvas thrash
    // and SIGWINCH spam that show up as a strobe during a drag.
    const resizeScheduler = createResizeScheduler(() => {
      const el = containerRef.current;
      refitAndRepaintVisibleTerminal(terminal, fitAddon, el);
    });
    // The deferred terminal cleanup disconnects this observer and disposes its scheduler.
    // react-doctor-disable-next-line effect-observer-needs-disconnect
    const resizeObserver = new ResizeObserver(() => resizeScheduler.schedule());
    resizeObserver.observe(containerRef.current!);

    if (!cancelled) send({ type: 'TERM_READY' });

    cleanup = () => {
      resizeScheduler.dispose();
      resizeObserver.disconnect();
      unregisterPtyCallback(id);
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      onBellDisposable.dispose();
      searchAddonRegistry.delete(id);
      terminalRegistry.delete(id);
      termRef.current = null;
      // Marked before dispose so the sample still reflects the terminal's cost.
      markMemoryPhase('terminal-close');
      terminal.dispose();
      // NOTE: Do NOT send pty:kill here. Component unmount happens on page
      // reload too, which would destroy persistent (tmux) sessions. The kill
      // is sent explicitly when the user closes the tab via handleCloseTab.
    };
  })();

  return () => {
    cancelled = true;
    if (focusTimeout !== undefined) clearTimeout(focusTimeout);
    if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
    if (settleFrame !== null) {
      cancelAnimationFrame(settleFrame);
      settleFrame = null;
      resolveSettleFrame?.();
      resolveSettleFrame = null;
    }
    cleanup?.();
  };
}
