import { create, type JsonObject } from '@bufbuild/protobuf';
import {
  createEndpointPolicy,
  createRealtimeController,
  getSidebarResyncTargets,
} from '@funny/client-core';
import { BROWSER_V1_SCHEMA_FINGERPRINT } from '@funny/shared/browser-protocol';
import {
  BrowserCapability,
  DeliveryClass,
  DeliveryMetadataSchema,
  RequestMetadataSchema,
  ScopeKind,
  ScopeReferenceSchema,
} from '@funny/shared/browser-v1/common';
import { SubscriptionRequestSchema } from '@funny/shared/browser-v1/events';
import { InteractiveEnvelopeSchema } from '@funny/shared/browser-v1/interactive';
import { NegotiationRequestSchema } from '@funny/shared/browser-v1/negotiation';
import { OperationRequestSchema } from '@funny/shared/browser-v1/operations';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { parseRoute } from '@/hooks/route-parser';
import { createClientLogger } from '@/lib/client-logger';
import { SocketIoClientRealtimePort } from '@/lib/realtime/socketio-realtime-port';
import { metric } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';
import { useAuthStore } from '@/stores/auth-store';
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
  dispatchRealtimeEvent,
  registerSocketIOHandlers,
  setWSStopped,
  unregisterSocketIOHandlers,
} from './ws-event-dispatch';

const wsLog = createClientLogger('ws');

// Module-level singleton to prevent duplicate connections
// (React StrictMode double-mounts effects in development).
let activeSocket: Socket | null = null;
let activeRealtimePort: SocketIoClientRealtimePort | null = null;
let refCount = 0;
// Tracks whether the socket has fired `connect` at least once this page
// session. The on-connect thread resync recovers events missed *while
// disconnected*, which only applies to RECONNECTS — on the very first connect
// the cold-load path has already fetched every visible thread fresh, so the
// resync is pure redundant work. For a heavy thread (megabytes of inline
// images) that duplicate full-payload refetch + merge forces the whole message
// list to repaint, which the user sees as a second load ("double refresh").
// The thread the user is currently viewing, mirrored to the server for
// thread-sharing presence. Module-level so the on-connect handler can re-join
// the room after a reconnect (Socket.IO room membership is lost on disconnect).
let lastOpenThreadId: string | undefined;
// Deferred teardown handle — coalesces StrictMode/HMR remount cycles so we
// don't tear down a still-handshaking socket and re-run the heavy on-connect
// refresh path on every Vite HMR update.
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
const terminalInputOrdinals = new Map<string, bigint>();
const browserInputOrdinals = new Map<string, bigint>();
const browserHeartbeatOrdinals = new Map<string, bigint>();
const TEARDOWN_DEFER_MS = 100;

async function authorizedResourceBase64(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`resource-fetch-${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('resource-read-failed'));
    reader.onload = () => resolve(String(reader.result ?? '').split(',', 2)[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

// Re-export for legacy callers that still import from `use-ws`.
export { connectRemoteWS, disconnectRemoteWS };

function connect() {
  setWSStopped(false);

  const url = createEndpointPolicy(clientComposition.platform.transport.environment).realtimeOrigin;

  const socket = io(url, {
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 10_000,
    transports: ['websocket', 'polling'],
  });

  activeSocket = socket;
  const realtimePort = new SocketIoClientRealtimePort(socket);
  activeRealtimePort = realtimePort;
  realtimePort.start();
  realtimePort.onApplicationEvent((event) => {
    const payload = event.payload;
    if (payload.case === 'user') {
      const data = payload.value.data ?? {};
      const threadId = typeof data.threadId === 'string' ? data.threadId : '';
      dispatchRealtimeEvent(payload.value.eventType, threadId, data);
    }
  });
  realtimePort.onInteractive((message) => {
    const payload = message.payload;
    if (payload.case === 'terminal') {
      const terminal = payload.value;
      switch (terminal.payload.case) {
        case 'output':
          dispatchRealtimeEvent('pty:data', '', {
            ptyId: terminal.terminalId,
            data: new TextDecoder().decode(terminal.payload.value.data),
          });
          break;
        case 'exit':
          dispatchRealtimeEvent('pty:exit', '', {
            ptyId: terminal.terminalId,
            exitCode: terminal.payload.value.exitCode ?? null,
          });
          break;
        case 'error':
          dispatchRealtimeEvent('pty:error', '', {
            ptyId: terminal.terminalId,
            error: terminal.payload.value.status?.message ?? 'Terminal failed',
          });
          break;
      }
      return;
    }
    if (payload.case === 'browserSession') {
      const browser = payload.value;
      switch (browser.payload.case) {
        case 'frame':
          if (browser.payload.value.frame?.authorizedUrl) {
            void authorizedResourceBase64(browser.payload.value.frame.authorizedUrl)
              .then((data) =>
                dispatchRealtimeEvent('browser-session:frame', '', {
                  sessionId: browser.browserSessionId,
                  data,
                }),
              )
              .catch((error) =>
                wsLog.warn('browser.v1 frame resource unavailable', {
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
          }
          break;
        case 'result':
          {
            const result = browser.payload.value.value ?? {};
            dispatchRealtimeEvent('browser-session:result', '', {
              sessionId: browser.browserSessionId,
              requestId: message.metadata?.requestId,
              ok: result.ok === true,
              value: result.value,
              error: typeof result.error === 'string' ? result.error : undefined,
            });
          }
          break;
        case 'status':
          dispatchRealtimeEvent('browser-session:error', '', {
            sessionId: browser.browserSessionId,
            message: browser.payload.value.message,
          });
          break;
        case 'close':
          dispatchRealtimeEvent('browser-session:closed', '', {
            sessionId: browser.browserSessionId,
            reason: browser.payload.value.reason,
          });
          break;
        case 'ready':
          dispatchRealtimeEvent('browser-session:ready', '', {
            sessionId: browser.browserSessionId,
            url: browser.payload.value.targetUrl,
          });
          break;
        case 'console':
          dispatchRealtimeEvent('browser-session:console', '', {
            sessionId: browser.browserSessionId,
            level: browser.payload.value.level,
            text: browser.payload.value.text,
            url: browser.payload.value.url,
            line: browser.payload.value.line,
            column: browser.payload.value.column,
            timestamp: Number(browser.payload.value.occurredAtMs),
          });
          break;
      }
    }
  });
  realtimePort.onRecoveryRequired((scope) => {
    wsLog.warn('browser.v1 authoritative resynchronization required', {
      scope: ScopeKind[scope.kind] ?? String(scope.kind),
    });
    if (scope.kind === ScopeKind.USER) void useThreadStore.getState().loadSharedThreads();
    if (
      (scope.kind === ScopeKind.THREAD_STREAM || scope.kind === ScopeKind.THREAD_PRESENCE) &&
      useThreadStore.getState().selectedThreadId === scope.id
    ) {
      void useThreadStore.getState().refreshActiveThread();
    }
  });

  socket.on('connect', () => {
    const transport = socket.io.engine?.transport?.name ?? 'unknown';
    wsLog.info('Socket.IO connected', { transport });
    // Permanent metric: in prod we want to know if the user landed on
    // long-polling (reverse-proxy without WS upgrade) — that's the most
    // common cause of trailing `agent:result` events going missing.
    metric('ws.connected', 1, { attributes: { transport } });
    void realtimePort
      .negotiate(
        create(NegotiationRequestSchema, {
          supportedVersions: [{ major: 1, minor: 0 }],
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          capabilities: [
            BrowserCapability.OPERATIONS,
            BrowserCapability.EVENTS,
            BrowserCapability.TERMINAL,
            BrowserCapability.BROWSER_SESSION,
            BrowserCapability.CURSOR_RECOVERY,
            BrowserCapability.BINARY_POLLING,
          ],
          client: {
            instanceId: crypto.randomUUID(),
            applicationVersion: 'browser-client',
            deployment: clientComposition.platform.transport.environment.hostMode,
          },
        }),
      )
      .then((outcome) => {
        wsLog.info('browser.v1 negotiation completed', {
          status: outcome.outcome.case,
          representation: 'legacy',
        });
        if (outcome.outcome.case === 'success') {
          const userId = useAuthStore.getState().user?.id;
          if (userId) {
            const scope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: userId });
            void realtimePort.subscribeScope(
              create(SubscriptionRequestSchema, {
                scope,
                cursor: outcome.outcome.value.acceptedCursors.find(
                  (cursor) => cursor.scope?.kind === scope.kind && cursor.scope.id === scope.id,
                ),
              }),
            );
          }
        }
      })
      .catch((error) => {
        wsLog.warn('browser.v1 negotiation unavailable; continuing with legacy realtime', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    // Track transport upgrades (polling → websocket) so we can correlate
    // dropped trailing events with sockets that never finished upgrading.
    const engine = socket.io.engine;
    const handleTransportUpgrade = (t: any) => {
      const name = typeof t === 'string' ? t : (t?.name ?? 'unknown');
      wsLog.info('Socket.IO transport upgraded', { transport: name });
      metric('ws.transport_upgrade', 1, { attributes: { transport: name } });
    };
    engine?.on('upgrade', handleTransportUpgrade);

    useCircuitBreakerStore.getState().recordSuccess();
    // Only resync threads on RECONNECT. On the initial connect the cold-load
    // path already fetched everything fresh; resyncing here would refetch the
    // active thread's full payload a second time and repaint the message list
    // — visible as a "double refresh" on heavy threads (large inline images).
    realtimeController.handleConnected();
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
    if (lastOpenThreadId) {
      void realtimePort.operate(
        create(OperationRequestSchema, {
          metadata: { requestId: `thread-open:${crypto.randomUUID()}` },
          operation: { case: 'threadOpen', value: { threadId: lastOpenThreadId } },
        }),
      );
    }

    // Ack-based RPC: ask the server for the active PTY sessions and get a
    // single deterministic response — `{ status, sessions }`. Re-issued each
    // time the runner transitions to online so reconnects refresh tabs.
    let inflight = false;
    const requestPtyList = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const outcome = await realtimePort.operate(
          create(OperationRequestSchema, {
            metadata: { requestId: `pty-list:${crypto.randomUUID()}` },
            operation: { case: 'ptyList', value: {} },
          }),
        );
        const result = outcome.outcome;
        const sessions =
          result.case === 'success' && result.value.result.case === 'ptyList'
            ? result.value.result.value.terminals
            : [];
        if (sessions.length > 0) {
          const { useProjectStore } = await import('@/stores/project-store');
          const projects = useProjectStore.getState().projects;
          useTerminalStore.getState().restoreTabs(
            sessions as any,
            projects.map((p: any) => ({ id: p.id, path: p.path })),
          );
        } else {
          useTerminalStore.getState().markSessionsChecked();
        }
        wsLog.info('pty:list realtime operation completed', {
          status: result.case,
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
      engine?.off('upgrade', handleTransportUpgrade);
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
    activeRealtimePort?.stop();
    activeRealtimePort = null;
    unregisterSocketIOHandlers(activeSocket);
    activeSocket.disconnect();
    activeSocket = null;
  }
}

// Throttle resyncs triggered by visibility/focus events so rapid tab swaps
// don't fan out into multiple simultaneous refresh storms.
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
  return getSidebarResyncTargets(state);
}

function refreshLoadedSidebarRowsForActiveThreads(store: ThreadState) {
  const targets = getLoadedSidebarResyncTargets(store);
  for (const projectId of targets.projectIds) {
    void store.loadThreadsForProject(projectId);
  }
  if (targets.scratch) void store.loadScratchThreads();
  if (targets.shared) void store.loadSharedThreads();
}

function refreshThreadsOnFocus(reason: 'visibility' | 'focus') {
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

const realtimeController = createRealtimeController({
  lifecycle: clientComposition.platform.lifecycle,
  navigation: clientComposition.platform.navigation,
  connected: () => activeSocket?.connected === true,
  routeEligible: routeNeedsThreadResync,
  clock: Date.now,
  actions: {
    refreshForFocus: refreshThreadsOnFocus,
    refreshForReconnect: () => useThreadStore.getState().refreshAllLoadedThreads(),
    skipped(reason, cause) {
      if (cause === 'route') {
        wsLog.debug('Skipping focus resync — route does not display thread data', { reason });
      }
    },
  },
});

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
        if (lastOpenThreadId) {
          void activeRealtimePort?.operate(
            create(OperationRequestSchema, {
              metadata: { requestId: `thread-close:${crypto.randomUUID()}` },
              operation: { case: 'threadClose', value: { threadId: lastOpenThreadId } },
            }),
          );
        }
        if (openId) {
          void activeRealtimePort?.operate(
            create(OperationRequestSchema, {
              metadata: { requestId: `thread-open:${crypto.randomUUID()}` },
              operation: { case: 'threadOpen', value: { threadId: openId } },
            }),
          );
        }
        lastOpenThreadId = openId;
      }

      const containerUrl = thread?.runtime === 'remote' ? thread.containerUrl : undefined;

      if (containerUrl === lastContainerUrl) return;

      if (lastContainerUrl) disconnectRemoteWS(lastContainerUrl);
      if (containerUrl) connectRemoteWS(containerUrl);

      lastContainerUrl = containerUrl;
    });
    const stopRealtimeController = realtimeController.start();

    return () => {
      unsub();
      stopRealtimeController();
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

export type TerminalRealtimeCommand =
  | {
      case: 'spawn';
      cwd: string;
      cols: number;
      rows: number;
      projectId?: string;
      label?: string;
      shell?: string;
      scratchThreadId?: string;
    }
  | { case: 'write'; data: string }
  | { case: 'resize'; cols: number; rows: number }
  | { case: 'signal'; signal: string }
  | { case: 'rename'; title: string }
  | { case: 'reconnect'; lastSeenOutputSequence: bigint }
  | { case: 'restore' }
  | { case: 'close'; reason?: string };

/** Send terminal traffic through the negotiated realtime port with legacy rollback parity. */
export function sendTerminalRealtime(
  terminalId: string,
  command: TerminalRealtimeCommand,
): boolean {
  if (!activeRealtimePort || !activeSocket?.connected) return false;
  let deliveryClass: DeliveryClass;
  let payload: any;
  switch (command.case) {
    case 'spawn':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = {
        case: 'spawn',
        value: {
          terminalId,
          cwd: command.cwd,
          columns: command.cols,
          rows: command.rows,
          projectId: command.projectId,
          label: command.label,
          shell: command.shell,
          scratchThreadId: command.scratchThreadId,
        },
      };
      break;
    case 'write': {
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      const ordinal = (terminalInputOrdinals.get(terminalId) ?? 0n) + 1n;
      terminalInputOrdinals.set(terminalId, ordinal);
      payload = {
        case: 'write',
        value: { inputOrdinal: ordinal, data: new TextEncoder().encode(command.data) },
      };
      break;
    }
    case 'resize':
      deliveryClass = DeliveryClass.COALESCIBLE;
      payload = { case: 'resize', value: { columns: command.cols, rows: command.rows } };
      break;
    case 'signal':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      payload = { case: 'signal', value: { signal: command.signal } };
      break;
    case 'rename':
      deliveryClass = DeliveryClass.COALESCIBLE;
      payload = { case: 'rename', value: { title: command.title } };
      break;
    case 'reconnect':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = {
        case: 'reconnect',
        value: { lastSeenOutputSequence: command.lastSeenOutputSequence },
      };
      break;
    case 'restore':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = { case: 'restore', value: {} };
      break;
    case 'close':
      deliveryClass = DeliveryClass.DURABLE;
      payload = { case: 'close', value: { reason: command.reason ?? 'user' } };
      break;
  }
  activeRealtimePort.sendInteractive(
    create(InteractiveEnvelopeSchema, {
      delivery: create(DeliveryMetadataSchema, { deliveryClass }),
      payload: { case: 'terminal', value: { terminalId, payload } },
    }),
  );
  return true;
}

export type BrowserSessionRealtimeCommand =
  | { case: 'open'; targetUrl: string; projectId?: string }
  | { case: 'navigate'; targetUrl: string }
  | { case: 'input'; action: JsonObject }
  | { case: 'inspect'; selector: JsonObject; requestId: string }
  | { case: 'execute'; expression: string; requestId: string }
  | { case: 'historyNavigation'; action: string; requestId: string }
  | { case: 'screenshot'; requestId: string }
  | { case: 'heartbeat' }
  | { case: 'close'; reason?: string };

/** Send browser-session commands through their independently negotiated traffic class. */
export function sendBrowserSessionRealtime(
  browserSessionId: string,
  command: BrowserSessionRealtimeCommand,
): boolean {
  if (!activeRealtimePort || !activeSocket?.connected) return false;
  let deliveryClass: DeliveryClass;
  let payload: any;
  let requestId: string | undefined;
  switch (command.case) {
    case 'open':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = {
        case: 'open',
        value: { targetUrl: command.targetUrl, projectId: command.projectId },
      };
      break;
    case 'navigate':
      deliveryClass = DeliveryClass.COALESCIBLE;
      payload = { case: 'navigate', value: { targetUrl: command.targetUrl } };
      break;
    case 'input': {
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      const ordinal = (browserInputOrdinals.get(browserSessionId) ?? 0n) + 1n;
      browserInputOrdinals.set(browserSessionId, ordinal);
      payload = { case: 'input', value: { inputOrdinal: ordinal, action: command.action } };
      break;
    }
    case 'inspect':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      requestId = command.requestId;
      payload = { case: 'inspect', value: { selector: command.selector } };
      break;
    case 'execute':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'execute', value: { expression: command.expression } };
      break;
    case 'historyNavigation':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'historyNavigation', value: { action: command.action } };
      break;
    case 'screenshot':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'screenshot', value: {} };
      break;
    case 'heartbeat': {
      deliveryClass = DeliveryClass.VOLATILE;
      const ordinal = (browserHeartbeatOrdinals.get(browserSessionId) ?? 0n) + 1n;
      browserHeartbeatOrdinals.set(browserSessionId, ordinal);
      payload = { case: 'heartbeat', value: { ordinal } };
      break;
    }
    case 'close':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = { case: 'close', value: { reason: command.reason ?? 'user' } };
      break;
  }
  activeRealtimePort.sendInteractive(
    create(InteractiveEnvelopeSchema, {
      metadata: requestId ? create(RequestMetadataSchema, { requestId }) : undefined,
      delivery: create(DeliveryMetadataSchema, { deliveryClass }),
      payload: { case: 'browserSession', value: { browserSessionId, payload } },
    }),
  );
  return true;
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
