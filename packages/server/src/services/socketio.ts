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

import { log } from '../lib/logger.js';
import { setIO as setRelayIO } from './ws-relay.js';
import { setIO as setTunnelIO } from './ws-tunnel.js';

// ── State ────────────────────────────────────────────────

let io: SocketIOServer | null = null;
let engine: BunEngine | null = null;
let authInstance: any = null;

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
    'pty:rename',
    'pty:reconnect',
  ];

  for (const eventName of ptyEvents) {
    socket.on(eventName, async (data: any) => {
      const projectId = data?.projectId;

      const forwardToRunner = async (runnerId: string | null) => {
        if (runnerId) {
          const runnerNsp = getIO().of('/runner');
          runnerNsp.to(`runner:${runnerId}`).emit('central:browser_ws', {
            userId,
            data: { type: eventName, data },
          });
        } else if (eventName === 'pty:spawn') {
          socket.emit('pty:error', {
            ptyId: data?.id,
            error: 'No runner available to handle terminal request',
          });
        }
      };

      if (projectId) {
        try {
          const rm = await import('./runner-manager.js');
          const result = await rm.findRunnerForProject(projectId);
          const { getAnyConnectedRunnerId } = await import('./ws-relay.js');
          forwardToRunner(result?.runner.runnerId ?? getAnyConnectedRunnerId());
        } catch {
          const { getAnyConnectedRunnerId } = await import('./ws-relay.js');
          forwardToRunner(getAnyConnectedRunnerId());
        }
      } else {
        const { getAnyConnectedRunnerId } = await import('./ws-relay.js');
        forwardToRunner(getAnyConnectedRunnerId());
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
  runnerNsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('No runner token'));
      }

      const rm = await import('./runner-manager.js');
      const runnerId = await rm.authenticateRunner(token);
      if (!runnerId) {
        return next(new Error('Invalid runner token'));
      }

      socket.data = {
        runnerId,
        type: 'runner',
      };
      next();
    } catch {
      next(new Error('Runner authentication failed'));
    }
  });

  runnerNsp.on('connection', async (socket: Socket) => {
    const runnerId = socket.data.runnerId as string;

    // Cancel any pending offline timer from a previous disconnect
    const pendingTimer = offlineTimers.get(runnerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      offlineTimers.delete(runnerId);
    }

    // Join runner-specific room
    socket.join(`runner:${runnerId}`);

    // Register in ws-relay for isRunnerConnected() checks
    const wsRelay = await import('./ws-relay.js');
    wsRelay.addRunnerClient(runnerId, socket.id);

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
    socket.on('runner:agent_event', async (data: any) => {
      if (!data.userId) return;
      wsRelay.relayToUser(data.userId, data.event);

      const threadRegistry = await import('./thread-registry.js');
      if (data.event?.type === 'agent:status' && data.event?.threadId) {
        threadRegistry
          .updateThreadStatus(data.event.threadId, data.event.data?.status || 'running')
          .catch(() => {});
      }
      if (data.event?.type === 'agent:result' && data.event?.threadId) {
        threadRegistry.updateThreadStatus(data.event.threadId, 'completed').catch(() => {});
      }
    });

    // Handle browser relay from runner
    socket.on('runner:browser_relay', (data: any) => {
      if (data.userId) {
        wsRelay.relayToUser(data.userId, data.data);
      }
    });

    // Handle runner control messages (heartbeat, task polling, project assignment)
    setupRunnerControlHandlers(socket, runnerId);

    // Handle data persistence messages with ack callbacks
    setupRunnerDataHandlers(socket, runnerId);

    // Grace period before marking runner offline — Socket.IO reconnects
    // automatically on transport hiccups, so a brief disconnect shouldn't
    // make the runner unreachable. Only mark offline if the runner hasn't
    // reconnected within the grace window (timer is cancelled on reconnect).
    const OFFLINE_GRACE_MS = 15_000;

    socket.on('disconnect', (reason) => {
      log.warn('Runner disconnected from Socket.IO', {
        namespace: 'socketio',
        runnerId,
        reason,
      });

      const timer = setTimeout(async () => {
        offlineTimers.delete(runnerId);

        // Runner reconnected on a new socket — skip cleanup
        if (wsRelay.isRunnerConnected(runnerId)) return;

        wsRelay.removeRunnerClient(runnerId);

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
      ack?.({ error: (err as Error).message, success: false });
    }
  });

  // Task polling — runner asks for pending tasks
  socket.on('runner:poll_tasks', async (_data: any, ack?: (response: any) => void) => {
    try {
      const rm = await import('./runner-manager.js');
      const tasks = await rm.getPendingTasks(runnerId);
      ack?.({ tasks });
    } catch (err) {
      ack?.({ tasks: [], error: (err as Error).message });
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
      ack?.({ ok: false, error: (err as Error).message });
    }
  });
}

/**
 * Set up data persistence handlers for a runner socket.
 * Each data message uses Socket.IO acknowledgements for request/response.
 */
function setupRunnerDataHandlers(socket: Socket, runnerId: string): void {
  // Data persistence messages — use the existing data-handler
  // but with ack callbacks instead of sendToRunner
  const dataEvents = [
    'data:insert_message',
    'data:insert_tool_call',
    'data:update_thread',
    'data:update_message',
    'data:update_tool_call_output',
    'data:get_thread',
    'data:get_tool_call',
    'data:find_tool_call',
    'data:get_project',
    'data:list_projects',
    'data:resolve_project_path',
    'data:create_thread',
    'data:delete_thread',
    'data:enqueue_message',
    'data:save_thread_event',
    'data:get_profile',
    'data:get_github_token',
    'data:update_profile',
    'data:get_arc',
  ];

  for (const eventName of dataEvents) {
    socket.on(eventName, async (data: any, ack?: (response: any) => void) => {
      try {
        const { handleDataMessageWithAck } = await import('./data-handler.js');
        const response = await handleDataMessageWithAck(runnerId, {
          type: eventName,
          ...data,
        });
        if (ack && response !== undefined) {
          ack(response);
        }
      } catch (err) {
        log.error('Failed to handle data message', {
          namespace: 'socketio',
          runnerId,
          type: eventName,
          error: (err as Error).message,
        });
        if (ack) {
          ack({ error: (err as Error).message, success: false });
        }
      }
    });
  }
}
