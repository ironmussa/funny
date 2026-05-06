/**
 * Socket.IO server setup for runner and browser communication.
 *
 * Uses @socket.io/bun-engine for native Bun WebSocket integration
 * instead of the default engine.io (which requires Node.js HTTP server events).
 *
 * Two namespaces:
 * - `/` (default): Browser clients, authenticated via session cookie
 * - `/runner`: Runner clients, authenticated via bearer token
 */

import { Server as BunEngine } from '@socket.io/bun-engine';
import { Server as SocketIOServer, type Socket } from 'socket.io';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import { setIO as setRelayIO } from './ws-relay.js';
import { setIO as setTunnelIO } from './ws-tunnel.js';

// ── State ────────────────────────────────────────────────

let io: SocketIOServer | null = null;
let engine: BunEngine | null = null;
let authInstance: any = null;

// ── Per-socket rate limiter ─────────────────────────────

/** Sliding window rate limiter keyed by socket ID. */
const socketRateCounters = new Map<string, number[]>();

/**
 * Check whether a socket has exceeded its message rate limit.
 * Returns true if the message should be dropped.
 */
function isRateLimited(socketId: string, maxPerWindow = 100, windowMs = 10_000): boolean {
  const now = Date.now();
  const timestamps = socketRateCounters.get(socketId) ?? [];
  const valid = timestamps.filter((t) => now - t < windowMs);
  if (valid.length >= maxPerWindow) return true;
  valid.push(now);
  socketRateCounters.set(socketId, valid);
  return false;
}

/** Remove rate counter for a disconnected socket. */
function clearSocketRate(socketId: string): void {
  socketRateCounters.delete(socketId);
}

// ── Initialization ───────────────────────────────────────

/**
 * Create and configure the Socket.IO server with Bun engine.
 * Must be called after auth is initialized.
 *
 * Returns the Bun engine — the caller must spread `engine.handler()`
 * into `Bun.serve()` config and route `/socket.io/*` requests via
 * `engine.handleRequest()`.
 */
export function createSocketIOServer(
  auth: any,
  corsOrigins: string[],
): { io: SocketIOServer; engine: BunEngine } {
  authInstance = auth;

  // Create the Bun-native engine (replaces engine.io)
  engine = new BunEngine({
    path: '/socket.io/',
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 5e6,
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
  });

  // Create Socket.IO server (no standalone engine — we bind our Bun engine)
  io = new SocketIOServer();
  io.bind(engine as any);

  // Share the IO instance with ws-relay and ws-tunnel (avoids circular imports)
  setRelayIO(io);
  setTunnelIO(io);

  setupBrowserNamespace();
  setupRunnerNamespace();

  log.info('Socket.IO server created with Bun engine', { namespace: 'socketio' });

  return { io, engine };
}

/**
 * Get the Bun engine instance (for use in Bun.serve config).
 */
export function getEngine(): BunEngine {
  if (!engine) throw new Error('Socket.IO engine not initialized');
  return engine;
}

/**
 * Get the Socket.IO server instance.
 */
export function getIO(): SocketIOServer {
  if (!io) throw new Error('Socket.IO server not initialized');
  return io;
}

/**
 * Gracefully close the Socket.IO server.
 */
export async function closeSocketIO(): Promise<void> {
  if (io) {
    io.close();
    io = null;
  }
  engine = null;
}

// ── Browser Namespace (/) ────────────────────────────────

function setupBrowserNamespace(): void {
  if (!io) return;

  const browserNsp = io.of('/');

  // Auth middleware: validate session cookie
  browserNsp.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      if (!cookieHeader) {
        return next(new Error('No session cookie'));
      }

      // Create a minimal request with the cookie header for Better Auth
      const headers = new Headers();
      headers.set('cookie', cookieHeader);
      const session = await authInstance.api.getSession({ headers });

      if (!session) {
        return next(new Error('Invalid session'));
      }

      // Store user info on the socket
      socket.data = {
        userId: session.user.id,
        type: 'browser',
      };
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  browserNsp.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;

    // Join user-specific room for targeted event delivery
    socket.join(`user:${userId}`);

    log.info('Browser client connected via Socket.IO', {
      namespace: 'socketio',
      userId,
      socketId: socket.id,
      transport: socket.conn.transport.name,
    });

    // Handle PTY commands from browser
    setupBrowserPtyHandlers(socket, userId);

    socket.on('disconnect', (reason) => {
      clearSocketRate(socket.id);
      log.info('Browser client disconnected', {
        namespace: 'socketio',
        userId,
        reason,
      });
    });
  });
}

/**
 * Set up PTY command handlers for a browser socket.
 * Forwards PTY commands to the appropriate runner.
 */
function setupBrowserPtyHandlers(socket: Socket, userId: string): void {
  const ptyEvents = [
    'pty:list',
    'pty:spawn',
    'pty:write',
    'pty:resize',
    'pty:close',
    'pty:kill',
    'pty:signal',
    'pty:rename',
    'pty:reconnect',
    'pty:restore',
  ];

  for (const eventName of ptyEvents) {
    socket.on(eventName, async (data: unknown) => {
      // Per-socket rate limiting
      if (isRateLimited(socket.id)) return;
      // Basic schema validation: must be an object (or null/undefined)
      if (data != null && (typeof data !== 'object' || Array.isArray(data))) return;
      const payload = (data ?? {}) as Record<string, any>;
      const projectId = payload.projectId;

      const forwardToRunner = async (runnerId: string | null) => {
        if (runnerId) {
          // Emit to the specific current socketId rather than the runner's
          // room. During a reconnect both the old and new sockets may briefly
          // coexist in the room; addressing one socket avoids the duplicate.
          const wsRelay = await import('./ws-relay.js');
          const socketId = wsRelay.getRunnerSocketId(runnerId);
          if (socketId) {
            getIO()
              .of('/runner')
              .to(socketId)
              .emit('central:browser_ws', {
                userId,
                data: { type: eventName, data: payload },
              });
          } else if (eventName === 'pty:spawn') {
            socket.emit('pty:error', {
              ptyId: payload.id,
              error: 'No runner available to handle terminal request',
            });
          }
        } else if (eventName === 'pty:spawn') {
          socket.emit('pty:error', {
            ptyId: payload.id,
            error: 'No runner available to handle terminal request',
          });
        }
      };

      // Ownership gate: PTY traffic must only flow to a runner that belongs
      // to the requesting user. We never fall back to "any connected runner"
      // because that would leak shell access across tenants (see CLAUDE.md
      // Runner Isolation rule).
      const rm = await import('./runner-manager.js');

      if (projectId) {
        try {
          const projectRepo = await import('./project-repository.js');
          const project = await projectRepo.getProject(projectId);
          if (!project || project.userId !== userId) {
            log.warn('Blocked cross-user PTY request', {
              namespace: 'socketio',
              event: eventName,
              userId,
              projectId,
              ownerId: project?.userId ?? null,
            });
            audit({
              action: 'authz.cross_tenant_refused',
              actorId: userId ?? null,
              detail: 'Browser PTY request refused — project not owned by caller',
              meta: {
                source: 'socketio:browser_pty',
                event: eventName,
                projectId,
                ownerId: project?.userId ?? null,
              },
            });
            if (eventName === 'pty:spawn') {
              socket.emit('pty:error', {
                ptyId: payload.id,
                error: 'Project not found',
              });
            }
            return;
          }
          const result = await rm.findRunnerForProject(projectId);
          const runnerId = result?.runner.runnerId ?? null;
          if (runnerId) {
            const runnerUserId = await rm.getRunnerUserId(runnerId);
            if (runnerUserId !== userId) {
              log.warn('Runner for project owned by different user', {
                namespace: 'socketio',
                event: eventName,
                userId,
                projectId,
                runnerId,
                runnerUserId,
              });
              audit({
                action: 'authz.cross_tenant_refused',
                actorId: userId ?? null,
                detail: 'Browser PTY request refused — runner owned by different user',
                meta: {
                  source: 'socketio:browser_pty',
                  event: eventName,
                  projectId,
                  runnerId,
                  runnerUserId,
                },
              });
              if (eventName === 'pty:spawn') {
                socket.emit('pty:error', {
                  ptyId: payload.id,
                  error: 'No runner available to handle terminal request',
                });
              }
              return;
            }
          }
          await forwardToRunner(runnerId);
        } catch (e) {
          log.error('PTY forward failed', {
            namespace: 'socketio',
            event: eventName,
            userId,
            projectId,
            error: (e as Error).message,
          });
          if (eventName === 'pty:spawn') {
            socket.emit('pty:error', {
              ptyId: payload.id,
              error: 'No runner available to handle terminal request',
            });
          }
        }
      } else {
        // No projectId — route to any runner owned by this user.
        const runnerId = await rm.findAnyRunnerForUser(userId);
        if (!runnerId && eventName === 'pty:list') {
          // Runner not connected yet (e.g. browser refresh racing the runner's
          // re-handshake). Respond with an empty pending sessions list so the
          // client does not lock `sessionsChecked` and orphan live PTYs by
          // spawning new ones. The runner-connect handler below pushes a fresh
          // pty:list once a runner shows up, which delivers the real list.
          log.info('pty:list received with no runner connected — responding pending', {
            namespace: 'socketio',
            userId,
          });
          socket.emit('pty:sessions', { sessions: [], pending: true });
          return;
        }
        await forwardToRunner(runnerId);
      }
    });
  }
}

// ── Runner Namespace (/runner) ───────────────────────────

/** Pending offline timers — cancelled if the runner reconnects quickly. */
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setupRunnerNamespace(): void {
  if (!io) return;

  const runnerNsp = io.of('/runner');

  // Auth middleware: validate runner token
  //
  // Security M3: do not rely on the browser-oriented CORS `Origin` check that
  // the Bun engine performs at the HTTP upgrade — runners are machine-to-
  // machine clients that may not send an `Origin` header at all, and an
  // attacker controlling a browser can always set a truthful `Origin`. Instead
  // we enforce a bearer-token handshake with a hard timeout so that an
  // upgraded socket that never completes authentication cannot sit idle and
  // keep a connection slot.
  const AUTH_TIMEOUT_MS = 10_000;
  runnerNsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('No runner token'));
      }

      const rm = await import('./runner-manager.js');
      // Race the DB-backed token lookup against a short timeout so a hung
      // backend can't stall upgrade traffic indefinitely.
      const timeoutErr = Symbol('auth_timeout');
      const authResult: string | null | typeof timeoutErr = await Promise.race([
        rm.authenticateRunner(token),
        new Promise<typeof timeoutErr>((resolve) =>
          setTimeout(() => resolve(timeoutErr), AUTH_TIMEOUT_MS).unref(),
        ),
      ]);
      if (authResult === timeoutErr) {
        log.warn('Runner auth timed out during WS handshake', {
          namespace: 'socketio',
          timeoutMs: AUTH_TIMEOUT_MS,
        });
        return next(new Error('Authentication timed out'));
      }
      const runnerId = authResult;
      if (!runnerId) {
        return next(new Error('Invalid runner token'));
      }

      // Cache the runner's owning userId on the socket for tenant-isolation
      // checks on every subsequent data/event message. Legacy runners without
      // an owner resolve to null here and will be rejected from user-scoped
      // operations by the data handler.
      const runnerUserId = await rm.getRunnerUserId(runnerId);

      socket.data = {
        runnerId,
        runnerUserId,
        type: 'runner',
      };
      next();
    } catch {
      next(new Error('Runner authentication failed'));
    }
  });

  runnerNsp.on('connection', async (socket: Socket) => {
    const runnerId = socket.data.runnerId as string;
    const runnerUserId = (socket.data.runnerUserId ?? null) as string | null;

    // Cancel any pending offline timer from a previous disconnect
    const pendingTimer = offlineTimers.get(runnerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      offlineTimers.delete(runnerId);
    }

    // Register the new socketId first, atomically replacing any prior entry.
    // We hand off to ws-relay's map (the single source of truth) so that
    // emits routed by `getRunnerSocketId` land on this socket from the
    // moment it finishes connecting — the old socket stops receiving emits
    // as soon as the map is swapped, even if it is still in the room for a
    // few milliseconds while its disconnect propagates.
    const wsRelay = await import('./ws-relay.js');
    const replacedSocketId = wsRelay.addRunnerClient(runnerId, socket.id);

    // Disconnect any stale socket now that new traffic is guaranteed to
    // land on the fresh socket. We look the old socket up by id rather
    // than scanning room membership, which eliminates the `allSockets()`
    // race where two near-simultaneous reconnects could both evict the
    // same stale socket and then both join the room.
    if (replacedSocketId && replacedSocketId !== socket.id) {
      const stale = runnerNsp.sockets.get(replacedSocketId);
      if (stale) {
        log.warn('Evicting stale runner socket — replaced by new connection', {
          namespace: 'socketio',
          runnerId,
          staleSocketId: replacedSocketId,
          newSocketId: socket.id,
        });
        stale.disconnect(true);
      }
    }

    // Join runner-specific room (kept for back-compat with any consumers
    // that iterate rooms for diagnostics; emits now go by socketId).
    const room = `runner:${runnerId}`;
    socket.join(room);

    log.info('Runner connected via Socket.IO', {
      namespace: 'socketio',
      runnerId,
      socketId: socket.id,
      transport: socket.conn.transport.name,
    });

    // Push PTY sessions to browser clients on runner connect
    for (const userId of wsRelay.getConnectedBrowserUserIds()) {
      socket.emit('central:browser_ws', {
        userId,
        data: { type: 'pty:list', data: {} },
      });
    }

    // Handle agent events from runner → relay to browser
    socket.on('runner:agent_event', async (data: unknown) => {
      if (isRateLimited(socket.id, 500, 10_000)) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const msg = data as Record<string, any>;
      if (!msg.userId || typeof msg.userId !== 'string') return;

      // Tenant validation: each runner is associated with a specific userId.
      // Reject cross-tenant relays and reject legacy runners that have no
      // owner (runnerUserId === null) so they can't fan out to arbitrary users.
      if (!runnerUserId || runnerUserId !== msg.userId) {
        log.warn('Runner attempted cross-tenant event relay', {
          namespace: 'socketio',
          runnerId,
          runnerUserId,
          targetUserId: msg.userId,
        });
        audit({
          action: 'authz.cross_tenant_refused',
          actorId: runnerUserId,
          detail: 'runner agent_event relay refused',
          meta: { source: 'socketio:runner_agent_event', runnerId, targetUserId: msg.userId },
        });
        return;
      }

      wsRelay.relayToUser(msg.userId, msg.event);

      const threadRegistry = await import('./thread-registry.js');
      if (msg.event?.type === 'agent:status' && msg.event?.threadId) {
        threadRegistry
          .updateThreadStatus(msg.event.threadId, msg.event.data?.status || 'running')
          .catch(() => {});
      }
      if (msg.event?.type === 'agent:result' && msg.event?.threadId) {
        threadRegistry.updateThreadStatus(msg.event.threadId, 'completed').catch(() => {});
      }
    });

    // Handle browser relay from runner
    socket.on('runner:browser_relay', async (data: unknown) => {
      if (isRateLimited(socket.id, 500, 10_000)) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const relay = data as Record<string, any>;
      if (relay.userId && typeof relay.userId === 'string') {
        // Tenant validation: same as agent_event
        if (!runnerUserId || runnerUserId !== relay.userId) {
          log.warn('Runner attempted cross-tenant browser relay', {
            namespace: 'socketio',
            runnerId,
            runnerUserId,
            targetUserId: relay.userId,
          });
          audit({
            action: 'authz.cross_tenant_refused',
            actorId: runnerUserId,
            detail: 'runner browser_relay refused',
            meta: { source: 'socketio:runner_browser_relay', runnerId, targetUserId: relay.userId },
          });
          return;
        }
        wsRelay.relayToUser(relay.userId, relay.data);
      }
    });

    // Handle runner control messages (heartbeat, task polling, project assignment)
    setupRunnerControlHandlers(socket, runnerId);

    // Handle data persistence messages with ack callbacks
    setupRunnerDataHandlers(socket, runnerId, runnerUserId);

    // Grace period before marking runner offline — Socket.IO reconnects
    // automatically on transport hiccups, so a brief disconnect shouldn't
    // make the runner unreachable. Only mark offline if the runner hasn't
    // reconnected within the grace window (timer is cancelled on reconnect).
    const OFFLINE_GRACE_MS = 15_000;

    socket.on('disconnect', async (reason) => {
      clearSocketRate(socket.id);
      log.warn('Runner disconnected from Socket.IO', {
        namespace: 'socketio',
        runnerId,
        socketId: socket.id,
        reason,
      });

      // Clear the ws-relay mapping immediately so liveness checks
      // (`isRunnerConnected`, `getAnyConnectedRunnerId`, `findAnyRunnerForUser`)
      // don't keep returning a dead socket for 15 seconds — the stale-entry
      // window that caused emits to silently land in an empty room.
      //
      // Pass our socketId so the remove is a no-op if a newer socket has
      // already claimed the map slot (e.g. a reconnect that fired its
      // connect handler before our disconnect event arrived).
      const wasActive = wsRelay.getRunnerSocketId(runnerId) === socket.id;
      wsRelay.removeRunnerClient(runnerId, socket.id);

      // If a newer socket already took over, it owns the runner's liveness
      // and offline timing — our delayed disconnect must not schedule a
      // cleanup that would tear down the replacement.
      if (!wasActive) return;

      // Security M4: evict the thread→runner cache now. Without this, a
      // resolver lookup during the 15s grace window can return the just-
      // disconnected runner for any thread whose runner still has an httpUrl
      // (which would otherwise keep `isReachable` truthy), producing one or
      // two requests that go to an unresponsive runner before resolution
      // falls through to a fresh pick.
      const resolver = await import('./runner-resolver.js');
      resolver.evictRunnerFromCache(runnerId);

      // Grace period: defer the DB/resolver cleanup in case the runner
      // reconnects quickly. A reconnect cancels the timer via the
      // pendingTimer handling at the top of the connection block.
      const timer = setTimeout(async () => {
        offlineTimers.delete(runnerId);

        // A new socket may have reconnected during the grace window; if so
        // skip marking the runner offline.
        if (wsRelay.isRunnerConnected(runnerId)) return;

        const rm = await import('./runner-manager.js');
        rm.markRunnerOffline(runnerId).catch(() => {});

        const resolver = await import('./runner-resolver.js');
        resolver.evictRunnerFromCache(runnerId);
      }, OFFLINE_GRACE_MS);

      offlineTimers.set(runnerId, timer);
    });
  });
}

/**
 * Set up runner control handlers (heartbeat, task polling, project assignment).
 * These use Socket.IO ack callbacks for request/response.
 */
function setupRunnerControlHandlers(socket: Socket, runnerId: string): void {
  // Heartbeat — runner pings to stay alive, server responds with status
  socket.on('runner:heartbeat', async (data: any, ack?: (response: any) => void) => {
    try {
      const rm = await import('./runner-manager.js');
      const exists = await rm.handleHeartbeat(runnerId, data ?? { activeThreadIds: [] });
      if (!exists) {
        ack?.({ code: 'RUNNER_NOT_FOUND' });
      } else {
        const wsRelay = await import('./ws-relay.js');
        ack?.({ ok: true, wsConnected: wsRelay.isRunnerConnected(runnerId) });
      }
    } catch (err) {
      log.error('Heartbeat handler error', {
        namespace: 'socketio',
        runnerId,
        error: (err as Error).message,
      });
      ack?.({ error: 'Internal error', success: false });
    }
  });

  // Task polling — runner asks for pending tasks
  socket.on('runner:poll_tasks', async (_data: any, ack?: (response: any) => void) => {
    try {
      const rm = await import('./runner-manager.js');
      const tasks = await rm.getPendingTasks(runnerId);
      ack?.({ tasks });
    } catch (err) {
      log.error('Poll tasks handler error', {
        namespace: 'socketio',
        runnerId,
        error: (err as Error).message,
      });
      ack?.({ tasks: [], error: 'Internal error' });
    }
  });

  // Project assignment — runner assigns a local project
  socket.on('runner:assign_project', async (data: any, ack?: (response: any) => void) => {
    try {
      const payload = data?.payload ?? data;
      if (payload?.projectId && payload?.localPath) {
        const rm = await import('./runner-manager.js');
        await rm.assignProject(runnerId, {
          projectId: payload.projectId,
          localPath: payload.localPath,
        });
      }
      ack?.({ ok: true });
    } catch (err) {
      log.error('Assign project handler error', {
        namespace: 'socketio',
        runnerId,
        error: (err as Error).message,
      });
      ack?.({ ok: false, error: 'Internal error' });
    }
  });
}

/**
 * Set up data persistence handlers for a runner socket.
 *
 * Uses event-based request/response: the runner includes a `_requestId` in
 * each data message, and the server emits the response back on the shared
 * `data:response` event with `{ requestId, response }` (Security L2 — a
 * single event name instead of a dynamic `data:response:<id>` channel per
 * request, so the runner registers one persistent listener rather than one
 * `once()` per in-flight call). This avoids Socket.IO ack callbacks which
 * deadlock when the runner sends data requests while processing a
 * tunnel:request on the same connection (Bun WebSocket limitation).
 */
function setupRunnerDataHandlers(
  socket: Socket,
  runnerId: string,
  runnerUserId: string | null,
): void {
  const dataEvents = [
    'data:insert_message',
    'data:insert_tool_call',
    'data:update_thread',
    'data:update_message',
    'data:update_tool_call_output',
    'data:get_thread',
    'data:get_thread_with_messages',
    'data:get_tool_call',
    'data:find_tool_call',
    'data:find_last_unanswered_interactive_tool_call',
    'data:get_project',
    'data:list_projects',
    'data:list_project_threads',
    'data:resolve_project_path',
    'data:create_project',
    'data:create_thread',
    'data:delete_thread',
    'data:enqueue_message',
    'data:dequeue_message',
    'data:peek_message',
    'data:queue_count',
    'data:list_queue',
    'data:cancel_queued_message',
    'data:update_queued_message',
    'data:save_thread_event',
    'data:get_profile',
    'data:get_provider_key',
    'data:get_github_token',
    'data:get_minimax_api_key',
    'data:update_profile',
    'data:mark_and_list_stale_threads',
    'data:get_agent_template',
    'data:create_permission_rule',
    'data:find_permission_rule',
    'data:list_permission_rules',
  ];

  // Regex to validate requestId is a safe identifier (UUID or nanoid-like)
  const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  // Security M8: track currently in-flight requestIds per socket so that a
  // runner cannot reuse (or a malicious runner cannot collide on) the same
  // requestId while a prior request is still being handled. A duplicate would
  // otherwise race two responses onto the same `data:response` envelope,
  // letting one handler observe another's payload.
  const inFlightRequestIds = new Set<string>();
  socket.on('disconnect', () => inFlightRequestIds.clear());

  /** Shared-event emit helper (Security L2). */
  const emitDataResponse = (requestId: string, response: any) => {
    socket.emit('data:response', { requestId, response });
  };

  for (const eventName of dataEvents) {
    socket.on(eventName, async (data: any, ack?: (response: any) => void) => {
      const requestId = data?._requestId;
      // Data events are chatty during streaming tool output; use a higher cap
      // than control events. Drops MUST emit a response / ack so the caller
      // doesn't hang for the full 15s request timeout.
      if (isRateLimited(socket.id, 1000, 10_000)) {
        log.warn('Data event rate-limited — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          requestId,
        });
        const errorResponse = { error: 'Rate limit exceeded', success: false };
        if (requestId && typeof requestId === 'string' && REQUEST_ID_RE.test(requestId)) {
          emitDataResponse(requestId, errorResponse);
        } else if (ack) {
          ack(errorResponse);
        }
        return;
      }
      // Validate requestId format to prevent event name injection
      if (requestId && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) {
        log.warn('Invalid requestId format', { namespace: 'socketio', runnerId, type: eventName });
        return;
      }
      if (requestId && inFlightRequestIds.has(requestId)) {
        log.warn('Duplicate in-flight requestId — dropping', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          requestId,
        });
        // Emit an error on the shared response channel so the original
        // waiter sees something deterministic — but do not start a second
        // handler.
        emitDataResponse(requestId, {
          error: 'Duplicate requestId in flight',
          success: false,
        });
        return;
      }
      if (requestId) inFlightRequestIds.add(requestId);
      try {
        const { handleDataMessageWithAck } = await import('./data-handler.js');
        const response = await handleDataMessageWithAck(runnerId, runnerUserId, {
          type: eventName,
          ...data,
        });
        // Event-based response (L2 shared-event pattern): emit on `data:response`
        if (requestId && response !== undefined) {
          emitDataResponse(requestId, response);
        } else if (requestId) {
          // Fire-and-forget messages still need an empty ack so the runner doesn't time out
          emitDataResponse(requestId, { type: 'data:ack', success: true });
        }
        // Legacy ack fallback (for runners that still use the ack pattern)
        if (!requestId && ack && response !== undefined) {
          ack(response);
        }
      } catch (err) {
        log.error('Failed to handle data message', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          error: (err as Error).message,
        });
        const errorResponse = { error: (err as Error).message, success: false };
        if (requestId) {
          emitDataResponse(requestId, errorResponse);
        } else if (ack) {
          ack(errorResponse);
        }
      } finally {
        if (requestId) inFlightRequestIds.delete(requestId);
      }
    });
  }
}
