import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { TerminalPhaseOverlay } from '@/components/terminal/TerminalPhaseOverlay';
import { mountWebXterm } from '@/components/terminal/web-xterm-session';
import {
  getTerminalTheme,
  refitAndRepaintVisibleTerminal,
  useThemeSync,
} from '@/components/terminal/xterm-utils';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { getActiveWS, sendTerminalRealtime, subscribeActiveWS } from '@/hooks/use-ws';
import { watchSocketConnection } from '@/lib/realtime/watch-socket-connection';
import { cn } from '@/lib/utils';
import {
  renderPhaseFromState,
  terminalSpawnMachine,
  type TerminalRenderPhase,
} from '@/machines/terminal-spawn-machine';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { type TerminalShell, useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';
import { onPtySessionLost, tabSandboxThreadId, useTerminalStore } from '@/stores/terminal-store';

/** Forward socket connection and session-lost signals to a tab's spawn machine. */
function bridgeTerminalSignals(
  id: string,
  send: (
    event: { type: 'SOCKET_CONNECTED'; connected: boolean } | { type: 'SESSION_LOST' },
  ) => void,
): () => void {
  const unwatchSocket = watchSocketConnection(getActiveWS, subscribeActiveWS, (connected) =>
    send({ type: 'SOCKET_CONNECTED', connected }),
  );
  const offSessionLost = onPtySessionLost(id, () => send({ type: 'SESSION_LOST' }));
  return () => {
    unwatchSocket();
    offSessionLost();
  };
}

/**
 * Re-attach a live tab whose session the server/runner forgot after a restart.
 * The runner's snapshot repaints the whole screen, so start from a clean
 * screen instead of appending it below the old content.
 */
function reattachTerminal(term: { terminal: any } | null, spawn: () => void): void {
  term?.terminal.reset();
  spawn();
}

/** Web PTY tab — uses xterm.js over WebSocket */
export function WebTerminalTabContent({
  id,
  cwd,
  active,
  panelVisible,
  shell,
  restored,
  projectId,
  label,
  initialCommand,
  scratchThreadId,
  repaintKey,
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
  scratchThreadId?: string;
  repaintKey?: string;
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
  useLayoutEffect(() => {
    emitSpawnRef.current = () => {
      if (!termRef.current) return;
      const { fitAddon } = termRef.current;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      const cols = Math.max(dims?.cols ?? 80, 20);
      const rows = Math.max(dims?.rows ?? 24, 4);
      sendTerminalRealtime(id, {
        case: 'spawn',
        cwd,
        // For scratch tabs we route through the server's "any runner owned by
        // this user" branch — sending the synthetic '__scratch__' as projectId
        // would fail the server's project ownership lookup.
        projectId: scratchThreadId ? undefined : projectId,
        label,
        rows,
        cols,
        ...(shell !== 'default' && { shell }),
        ...(scratchThreadId && { scratchThreadId }),
        // A sandbox thread's terminal opens on its sandbox runner.
        sandboxThreadId: tabSandboxThreadId(id),
      });
    };
    emitRestoreRef.current = () => {
      sendTerminalRealtime(id, { case: 'restore' });
    };
  }, [cwd, id, label, projectId, scratchThreadId, shell]);

  const machineWithActions = useMemo(
    () =>
      terminalSpawnMachine.provide({
        actions: {
          emitSpawn: () => emitSpawnRef.current(),
          emitRestore: () => emitRestoreRef.current(),
          emitReattach: () => reattachTerminal(termRef.current, emitSpawnRef.current),
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
  // automatically without needing a manual restart — and follows the socket
  // when it is replaced (HMR / teardown), instead of the one seen at mount.
  // Also bridges "the server/runner forgot this terminal" (a restart) so the
  // machine re-attaches.
  useEffect(() => bridgeTerminalSignals(id, send), [id, send]);

  // mountWebXterm's teardown clears the focus timeout, cancels both RAFs, and disposes the terminal.
  // react-doctor-disable-next-line effect-needs-cleanup
  // label / initialCommand / font size are one-shot reads at mount: re-running
  // on their change would reset the live xterm.
  const mountTerminal = useStableCallback(() => {
    if (!containerRef.current) return;
    return mountWebXterm({
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
    });
  });
  useEffect(
    () => mountTerminal(),
    [id, cwd, registerPtyCallback, unregisterPtyCallback, mountTerminal],
  );

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
        const el = containerRef.current;
        if (!el || el.offsetParent === null || el.clientHeight <= 0) return;

        // Re-sync xterm theme with current CSS variables
        terminal.options.theme = getTerminalTheme();
        refitAndRepaintVisibleTerminal(terminal, fitAddon, el);
        // Force-send a resize in case fit() didn't trigger onResize
        // (e.g. when dimensions match the stale cached value in xterm).
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          sendTerminalRealtime(id, {
            case: 'resize',
            cols: dims.cols,
            rows: dims.rows,
          });
        }
        // Only focus if no modal dialog is open (see aria-hidden note above)
        if (shouldFocus && !document.querySelector('[role="dialog"][data-state="open"]')) {
          terminal.focus();
        }
      }, 220);
      return () => clearTimeout(timer);
    }
  }, [active, panelVisible, repaintKey, id]);

  useEffect(() => {
    prevActiveRef.current = active;
    prevPanelVisibleRef.current = panelVisible;
  }, [active, panelVisible]);

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
      <div ref={containerRef} className="bg-background size-full pt-1.5 pl-2" />
      <TerminalPhaseOverlay
        phase={phase}
        error={snapshot.context.error ?? tabError}
        onRestart={handleRestart}
      />
    </div>
  );
}
