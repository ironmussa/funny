import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { createClientLogger } from '@/lib/client-logger';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

import {
  clearWSDispatchState,
  connectRemoteWS,
  disconnectAllRemote,
  disconnectRemoteWS,
  registerSocketIOHandlers,
  setWSStopped,
} from './ws-event-dispatch';

const wsLog = createClientLogger('ws');

// Module-level singleton to prevent duplicate connections
// (React StrictMode double-mounts effects in development).
let activeSocket: Socket | null = null;
let refCount = 0;
// Deferred teardown handle — coalesces StrictMode/HMR remount cycles so we
// don't tear down a still-handshaking socket and re-run the heavy on-connect
// refresh path on every Vite HMR update.
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
const TEARDOWN_DEFER_MS = 100;

// Re-export for legacy callers that still import from `use-ws`.
export { connectRemoteWS, disconnectRemoteWS };

function connect() {
  setWSStopped(false);

  const isTauri = !!(window as any).__TAURI_INTERNALS__;
  const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
  const url = isTauri ? `http://localhost:${serverPort}` : window.location.origin;

  const socket = io(url, {
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 10_000,
    transports: ['websocket', 'polling'],
  });

  activeSocket = socket;

  socket.on('connect', () => {
    wsLog.info('Socket.IO connected', {
      transport: socket.io.engine?.transport?.name ?? 'unknown',
    });

    useCircuitBreakerStore.getState().recordSuccess();
    useThreadStore.getState().refreshAllLoadedThreads();
    // Re-sync git status — do NOT reset cooldowns; the increased cooldown (5s)
    // naturally throttles the thundering herd. WS git:status events will
    // invalidate specific keys when the server pushes fresh data.
    const loadedProjectIds = Object.keys(useThreadStore.getState().threadsByProject);
    for (const pid of loadedProjectIds) {
      useGitStatusStore.getState().fetchForProject(pid);
    }

    useTerminalStore.getState().resetSessionsChecked();
    // Reset runner readiness so we re-evaluate on this fresh connection — the
    // server emits the current `runner:status` to every browser-connect.
    useRunnerStatusStore.getState().reset();

    // Ack-based RPC: ask the server for the active PTY sessions and get a
    // single deterministic response — `{ status, sessions }`. Re-issued each
    // time the runner transitions to online so reconnects refresh tabs.
    const PTY_LIST_TIMEOUT_MS = 7_000;
    let inflight = false;
    const requestPtyList = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const response = await socket.timeout(PTY_LIST_TIMEOUT_MS).emitWithAck('pty:list', {});
        const result = response as
          | { status: 'ok' | 'no-runner' | 'timeout' | 'error'; sessions?: unknown[] }
          | undefined;
        const sessions = Array.isArray(result?.sessions) ? result!.sessions : [];
        if (result?.status === 'ok' && sessions.length > 0) {
          const { useProjectStore } = await import('@/stores/project-store');
          const projects = useProjectStore.getState().projects;
          useTerminalStore.getState().restoreTabs(
            sessions as any,
            projects.map((p: any) => ({ id: p.id, path: p.path })),
          );
        } else {
          useTerminalStore.getState().markSessionsChecked();
        }
        wsLog.info('pty:list RPC completed', {
          status: result?.status ?? 'unknown',
          count: sessions.length,
        });
      } catch (err) {
        wsLog.warn('pty:list RPC failed', { error: (err as Error).message });
        useTerminalStore.getState().markSessionsChecked();
      } finally {
        inflight = false;
      }
    };

    const unsubRunnerStatus = useRunnerStatusStore.subscribe((state, prev) => {
      if (state.status === 'online' && prev.status !== 'online') void requestPtyList();
    });
    if (useRunnerStatusStore.getState().status === 'online') void requestPtyList();

    socket.once('disconnect', () => {
      unsubRunnerStatus();
    });
  });

  socket.on('disconnect', (reason) => {
    wsLog.info('Socket.IO disconnected', { reason });
    useRunnerStatusStore.getState().reset();
    if (reason === 'io server disconnect') {
      import('@/stores/auth-store').then(({ useAuthStore }) => {
        useAuthStore.getState().logout();
      });
    }
  });

  socket.on('connect_error', (err) => {
    wsLog.error('Socket.IO connect error', { error: err.message });
  });

  registerSocketIOHandlers(socket);
}

function teardown() {
  setWSStopped(true);
  disconnectAllRemote();
  clearWSDispatchState();
  if (activeSocket) {
    activeSocket.disconnect();
    activeSocket = null;
  }
}

// Throttle resyncs triggered by visibility/focus events so rapid tab swaps
// don't fan out into multiple simultaneous refresh storms.
const VISIBILITY_RESYNC_MIN_INTERVAL_MS = 2_000;
let lastVisibilityResyncAt = 0;

function resyncOnFocus(reason: 'visibility' | 'focus') {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!activeSocket?.connected) return;
  const now = Date.now();
  if (now - lastVisibilityResyncAt < VISIBILITY_RESYNC_MIN_INTERVAL_MS) return;
  lastVisibilityResyncAt = now;
  wsLog.info('Tab regained focus — resyncing threads', { reason });
  useThreadStore.getState().refreshAllLoadedThreads();
}

export function useWS() {
  useEffect(() => {
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
    refCount++;
    if (refCount === 1 && !activeSocket) connect();

    // Auto-manage remote WS connections when the active thread is remote
    let lastContainerUrl: string | undefined;
    const unsub = useThreadStore.subscribe((state) => {
      const thread = state.activeThread;
      const containerUrl = thread?.runtime === 'remote' ? thread.containerUrl : undefined;

      if (containerUrl === lastContainerUrl) return;

      if (lastContainerUrl) disconnectRemoteWS(lastContainerUrl);
      if (containerUrl) connectRemoteWS(containerUrl);

      lastContainerUrl = containerUrl;
    });

    // Resync on tab visibility/focus — covers the case where Chrome throttles
    // background tabs or the WS dropped a terminal `agent:result` while the
    // tab was inactive. `refreshAllLoadedThreads` rehydrates status from DB.
    const onVisibility = () => resyncOnFocus('visibility');
    const onFocus = () => resyncOnFocus('focus');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      refCount--;
      if (refCount === 0) {
        // Defer teardown so StrictMode/HMR remounts (which fire cleanup then
        // immediately re-run the effect) cancel the disconnect instead of
        // tearing down the live socket mid-handshake.
        if (teardownTimer) clearTimeout(teardownTimer);
        teardownTimer = setTimeout(() => {
          teardownTimer = null;
          if (refCount === 0) teardown();
        }, TEARDOWN_DEFER_MS);
      }
    };
  }, []);
}

/** Get the active Socket.IO instance (for sending messages from components) */
export function getActiveWS(): Socket | null {
  return activeSocket;
}
