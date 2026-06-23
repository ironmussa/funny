import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { parseRoute } from '@/hooks/route-parser';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useRunnerStatusStore } from '@/stores/runner-status-store';
import { useTerminalStore } from '@/stores/terminal-store';
import type { ThreadState } from '@/stores/thread-state';
import { useThreadStore } from '@/stores/thread-store';

import {
  clearWSDispatchState,
  connectRemoteWS,
  disconnectAllRemote,
  disconnectRemoteWS,
  registerSocketIOHandlers,
  setWSStopped,
  unregisterSocketIOHandlers,
} from './ws-event-dispatch';

const wsLog = createClientLogger('ws');

// Module-level singleton to prevent duplicate connections
// (React StrictMode double-mounts effects in development).
let activeSocket: Socket | null = null;
let refCount = 0;
// Tracks whether the socket has fired `connect` at least once this page
// session. The on-connect thread resync recovers events missed *while
// disconnected*, which only applies to RECONNECTS — on the very first connect
// the cold-load path has already fetched every visible thread fresh, so the
// resync is pure redundant work. For a heavy thread (megabytes of inline
// images) that duplicate full-payload refetch + merge forces the whole message
// list to repaint, which the user sees as a second load ("double refresh").
let hasConnectedBefore = false;
// The thread the user is currently viewing, mirrored to the server for
// thread-sharing presence. Module-level so the on-connect handler can re-join
// the room after a reconnect (Socket.IO room membership is lost on disconnect).
let lastOpenThreadId: string | undefined;
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
    const transport = socket.io.engine?.transport?.name ?? 'unknown';
    wsLog.info('Socket.IO connected', { transport });
    // Permanent metric: in prod we want to know if the user landed on
    // long-polling (reverse-proxy without WS upgrade) — that's the most
    // common cause of trailing `agent:result` events going missing.
    metric('ws.connected', 1, { attributes: { transport } });
    // Track transport upgrades (polling → websocket) so we can correlate
    // dropped trailing events with sockets that never finished upgrading.
    socket.io.engine?.on('upgrade', (t: any) => {
      const name = typeof t === 'string' ? t : (t?.name ?? 'unknown');
      wsLog.info('Socket.IO transport upgraded', { transport: name });
      metric('ws.transport_upgrade', 1, { attributes: { transport: name } });
    });

    useCircuitBreakerStore.getState().recordSuccess();
    // Only resync threads on RECONNECT. On the initial connect the cold-load
    // path already fetched everything fresh; resyncing here would refetch the
    // active thread's full payload a second time and repaint the message list
    // — visible as a "double refresh" on heavy threads (large inline images).
    const isReconnect = hasConnectedBefore;
    hasConnectedBefore = true;
    if (shouldResyncThreadsOnConnect(isReconnect, window.location.pathname)) {
      useThreadStore.getState().refreshAllLoadedThreads();
    }
    // Re-sync git status — do NOT reset cooldowns; the increased cooldown (5s)
    // naturally throttles the thundering herd. WS git:status events will
    // invalidate specific keys when the server pushes fresh data.
    const loadedProjectIds = Object.keys(useThreadStore.getState().threadIdsByProject);
    for (const pid of loadedProjectIds) {
      useGitStatusStore.getState().fetchForProject(pid);
    }

    useTerminalStore.getState().resetSessionsChecked();
    // Reset runner readiness so we re-evaluate on this fresh connection — the
    // server emits the current `runner:status` to every browser-connect.
    useRunnerStatusStore.getState().reset();

    // Re-announce the open thread so the server re-joins us to the presence/
    // stream rooms — Socket.IO room membership is lost across a reconnect.
    if (lastOpenThreadId) socket.emit('thread:open', { threadId: lastOpenThreadId });

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
    unregisterSocketIOHandlers(activeSocket);
    activeSocket.disconnect();
    activeSocket = null;
  }
}

// Throttle resyncs triggered by visibility/focus events so rapid tab swaps
// don't fan out into multiple simultaneous refresh storms.
const VISIBILITY_RESYNC_MIN_INTERVAL_MS = 2_000;
let lastVisibilityResyncAt = 0;

// Routes that don't read thread data — skipping resync on these saves the
// N+1 listThreads requests fired by refreshAllLoadedThreads. When the user
// navigates back to a thread-bearing route, that route's own load path
// re-fetches; WS events still update threadsById in the background.
function routeNeedsThreadResync(pathname: string): boolean {
  const route = parseRoute(pathname);
  return !(
    route.settingsPage ||
    route.preferencesPage ||
    route.addProject ||
    route.scratchNew ||
    route.externalClaudeSessionId
  );
}

/**
 * Whether the on-`connect` handler should run the (expensive) thread resync.
 *
 * Gated on `isReconnect`: the resync only recovers events missed while the
 * socket was down, so it's needed on reconnects but is pure redundant work on
 * the initial connect — the cold-load path already fetched every visible
 * thread. Skipping it on first connect avoids a duplicate full-payload refetch
 * of the active thread (the "double refresh" symptom on heavy threads).
 */
export function shouldResyncThreadsOnConnect(isReconnect: boolean, pathname: string): boolean {
  return isReconnect && routeNeedsThreadResync(pathname);
}

const ACTIVE_SIDEBAR_STATUSES = new Set(['setting_up', 'pending', 'running', 'waiting']);

type SidebarResyncTargets = {
  projectIds: string[];
  scratch: boolean;
  shared: boolean;
};

export function getLoadedSidebarResyncTargets(
  state: Pick<
    ThreadState,
    'threadIdsByProject' | 'threadsById' | 'scratchThreadIds' | 'sharedThreadIds'
  >,
): SidebarResyncTargets {
  const projectIds: string[] = [];

  for (const [projectId, threadIds] of Object.entries(state.threadIdsByProject)) {
    const hasActiveThread = threadIds.some((id) =>
      ACTIVE_SIDEBAR_STATUSES.has(state.threadsById[id]?.status),
    );
    if (hasActiveThread) projectIds.push(projectId);
  }

  return {
    projectIds,
    scratch: state.scratchThreadIds.some((id) =>
      ACTIVE_SIDEBAR_STATUSES.has(state.threadsById[id]?.status),
    ),
    shared: state.sharedThreadIds.some((id) =>
      ACTIVE_SIDEBAR_STATUSES.has(state.threadsById[id]?.status),
    ),
  };
}

function refreshLoadedSidebarRowsForActiveThreads(store: ThreadState) {
  const targets = getLoadedSidebarResyncTargets(store);
  for (const projectId of targets.projectIds) {
    void store.loadThreadsForProject(projectId);
  }
  if (targets.scratch) void store.loadScratchThreads();
  if (targets.shared) void store.loadSharedThreads();
}

function resyncOnFocus(reason: 'visibility' | 'focus') {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!activeSocket?.connected) return;
  const now = Date.now();
  if (now - lastVisibilityResyncAt < VISIBILITY_RESYNC_MIN_INTERVAL_MS) return;
  if (!routeNeedsThreadResync(window.location.pathname)) {
    wsLog.debug('Skipping focus resync — route does not display thread data', { reason });
    return;
  }
  lastVisibilityResyncAt = now;
  wsLog.info('Tab regained focus — resyncing threads', { reason });
  // Prefer narrow refresh: when one thread is active (project or scratch
  // detail view), refreshing only that thread avoids the N+1 listThreads
  // pattern. Bulk refresh is reserved for cross-project views (inbox,
  // kanban, grid, analytics) where every loaded project's status matters.
  const store = useThreadStore.getState();
  if (store.activeThread) {
    void store.refreshActiveThread();
    refreshLoadedSidebarRowsForActiveThreads(store);
  } else {
    void store.refreshAllLoadedThreads();
  }
}

export function useWS() {
  useEffect(() => {
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
    refCount++;
    if (refCount === 1 && !activeSocket) connect();

    // Auto-manage remote WS connections when the active thread is remote, and
    // announce which thread we're viewing for thread-sharing presence/stream.
    let lastContainerUrl: string | undefined;
    const unsub = useThreadStore.subscribe((state) => {
      const thread = state.activeThread;

      // Presence: tell the server which thread is open so it joins us to the
      // presence room (and, for sharees, the stream room) and broadcasts our
      // avatar. Event names mirror `@funny/shared/socket-events`.
      const openId = thread?.id;
      if (openId !== lastOpenThreadId) {
        if (lastOpenThreadId) activeSocket?.emit('thread:close', { threadId: lastOpenThreadId });
        if (openId) activeSocket?.emit('thread:open', { threadId: openId });
        lastOpenThreadId = openId;
      }

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

// ── HMR cleanup ─────────────────────────────────────────────────
// Vite re-evaluates this module on hot updates. The `useWS` React effect
// only re-runs on component unmount, NOT on module replacement — so the
// `activeSocket` from the previous module instance stays alive with its
// (now-stale) listeners pointing at the previous `ws-event-dispatch`
// module. That produces ghost handlers running in parallel with the live
// ones: each WS event is dispatched N times, and the ghosts' stale
// `useThreadStore` closures `set()` over the live store with empty
// activeThread snapshots — wiping the assistant text bubble right after
// it was applied. Tearing the socket down on dispose forces a clean
// reconnect on the next module evaluation.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    refCount = 0;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
    teardown();
  });
}
