import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { createClientLogger } from '@/lib/client-logger';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useGitStatusStore } from '@/stores/git-status-store';
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

    socket.emit('pty:list', {});
    const sessionsTimeout = setTimeout(() => {
      const termStore = useTerminalStore.getState();
      if (!termStore.sessionsChecked) {
        termStore.markSessionsChecked();
      }
    }, 15_000);
    socket.once('disconnect', () => clearTimeout(sessionsTimeout));
  });

  socket.on('disconnect', (reason) => {
    wsLog.info('Socket.IO disconnected', { reason });
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

export function useWS() {
  useEffect(() => {
    refCount++;
    if (refCount === 1) connect();

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

    return () => {
      unsub();
      refCount--;
      if (refCount === 0) teardown();
    };
  }, []);
}

/** Get the active Socket.IO instance (for sending messages from components) */
export function getActiveWS(): Socket | null {
  return activeSocket;
}
