/**
 * Server entry point.
 *
 * The server initializes its own DB, auth, and data routes.
 * Filesystem/git/agent operations are proxied to remote runners
 * connected via WebSocket tunnel.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import type { ServerEnv } from './lib/types.js';

/** Data attached to each WebSocket connection. */
type WSData = {
  type: 'browser' | 'runner';
  req?: Request;
  userId?: string;
  runnerId?: string;
  organizationId?: string | null;
  isTranscribe?: boolean;
  ip?: string;
};

import { log } from './lib/logger.js';
import { authMiddleware, setAuthInstance } from './middleware/auth.js';

// ── Init ────────────────────────────────────────────────

// Auth instance — populated during init, used by middleware and route handlers.
// Uses `any` because the runtime and server auth instances have slightly different types
// (different access control statements, different plugin configurations).
let authInstance: any;

// Ensure a RUNNER_AUTH_SECRET exists
if (!process.env.RUNNER_AUTH_SECRET) {
  log.error('RUNNER_AUTH_SECRET is required. Set it in your .env file.', {
    namespace: 'server',
  });
  process.exit(1);
}

// ── Always initialize server DB and auth ────────────────
const { initDatabase } = await import('./db/index.js');
const { autoMigrate } = await import('./db/migrate.js');
const { initBetterAuth, auth } = await import('./lib/auth.js');

const dbResult = await initDatabase();
if (dbResult.isErr()) {
  log.error(dbResult.error, { namespace: 'db' });
  process.exit(1);
}
await autoMigrate();
await initBetterAuth();
authInstance = auth;
setAuthInstance(authInstance);

log.info('Server DB and auth initialized', { namespace: 'server' });

// On restart, purge all runners and their project assignments.
// No runner has an active WebSocket connection at this point, so all
// state is stale. Runners will re-register and re-assign projects on connect.
const { purgeAllRunners } = await import('./services/runner-manager.js');
await purgeAllRunners();

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use('*', cors({ origin: corsOrigins, credentials: true }));
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  }),
);
app.use('*', logger());

// Health check (before auth)
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Bootstrap endpoint (public — returns minimal info for client init)
app.get('/api/bootstrap', (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  return c.json({ mode: 'local' });
});

// ── Public routes (before auth middleware) ────────────────
const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('./routes/invite-links.js');
app.route('/api/invite-links', inviteLinkPublicRoutes);

// Better Auth routes — use app.all to handle all HTTP methods (GET, POST, DELETE, etc.)
app.all('/api/auth/*', (c) => authInstance.handler(c.req.raw));

// Auth middleware for all API routes
app.use('/api/*', authMiddleware);

// ── Server-managed data routes ───────────────────────────
const { authRoutes } = await import('./routes/auth.js');
const { projectRoutes } = await import('./routes/projects.js');
const { runnerRoutes } = await import('./routes/runners.js');
const { profileRoutes } = await import('./routes/profile.js');
const { threadRoutes } = await import('./routes/threads.js');
const { automationRoutes } = await import('./routes/automations.js');
const { settingsRoutes } = await import('./routes/settings.js');
const { teamProjectRoutes } = await import('./routes/team-projects.js');
const { teamSettingsRoutes } = await import('./routes/team-settings.js');
const { analyticsRoutes } = await import('./routes/analytics.js');
const { pipelineRoutes } = await import('./routes/pipelines.js');
const { arcRoutes, arcProjectRoutes } = await import('./routes/arcs.js');

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/runners', runnerRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/threads', threadRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/team-projects', teamProjectRoutes);
app.route('/api/team-settings', teamSettingsRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/pipelines', pipelineRoutes);
app.route('/api/invite-links', inviteLinkRoutes);
app.route('/api/arcs', arcRoutes);
app.route('/api/projects', arcProjectRoutes);

// Setup status — proxy to runner
app.get('/api/setup/status', async (c) => {
  return c.json({
    providers: {},
    claudeCli: { available: true, path: null, error: null, version: null },
    agentSdk: { available: true },
  });
});

// ── Proxy catch-all: forward remaining API requests to runner ──
const { proxyToRunner } = await import('./middleware/proxy.js');
app.all('/api/*', proxyToRunner);

// Serve static files from client build (only if dist exists)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  app.get('*', async (c) => {
    return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
}

// ── Server ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// WebSocket connection rate limiting — prevents connection flood DoS
const WS_MAX_CONNECTIONS_PER_IP = 50;
const wsConnectionCounts = new Map<string, number>();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  reusePort: true,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Browser WebSocket
    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      const ip = server.requestIP(req)?.address ?? 'unknown';
      const count = wsConnectionCounts.get(ip) ?? 0;
      if (count >= WS_MAX_CONNECTIONS_PER_IP) {
        return new Response('Too many WebSocket connections', { status: 429 });
      }
      const upgraded = server.upgrade(req, {
        data: { type: 'browser', req, ip } as any,
      });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
      wsConnectionCounts.set(ip, count + 1);
      return undefined;
    }

    // Runner WebSocket
    if (url.pathname === '/ws/runner' && req.headers.get('upgrade') === 'websocket') {
      const ip = server.requestIP(req)?.address ?? 'unknown';
      const count = wsConnectionCounts.get(ip) ?? 0;
      if (count >= WS_MAX_CONNECTIONS_PER_IP) {
        return new Response('Too many WebSocket connections', { status: 429 });
      }
      const upgraded = server.upgrade(req, {
        data: { type: 'runner', ip } as any,
      });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
      wsConnectionCounts.set(ip, count + 1);
      return undefined;
    }

    return app.fetch(req, { IP: server.requestIP(req) });
  },
  websocket: {
    idleTimeout: 500, // seconds — reset by any incoming message (including keepalive pings)
    sendPings: true, // Bun sends protocol-level pings before idle timeout
    async open(ws) {
      const wsData = ws.data as unknown as WSData;

      if (wsData.type === 'runner') {
        log.info('Runner WebSocket connection opened', {
          namespace: 'server',
          ip: (ws.data as any).ip,
        });
      }

      if (wsData.type === 'browser' && wsData.req) {
        const session = await authInstance.api.getSession({ headers: wsData.req.headers });
        if (!session) {
          ws.close(4001, 'Unauthorized');
          return;
        }
        (ws.data as any).userId = session.user.id;
        const wsRelay = await import('./services/ws-relay.js');
        wsRelay.addBrowserClient(session.user.id, ws);
      }
    },

    async message(ws, message) {
      const wsData = ws.data as unknown as WSData;

      try {
        const data = JSON.parse(typeof message === 'string' ? message : message.toString());
        const rm = await import('./services/runner-manager.js');
        const wsRelay = await import('./services/ws-relay.js');
        const threadRegistry = await import('./services/thread-registry.js');

        if (wsData.type === 'runner') {
          // Keepalive ping — respond with pong so the runner knows we're alive
          if (data.type === 'runner:ping') {
            try {
              ws.send(JSON.stringify({ type: 'runner:pong' }));
            } catch {}
            return;
          }

          if (data.type === 'runner:auth' && data.token) {
            const runnerId = await rm.authenticateRunner(data.token);
            if (runnerId) {
              (ws.data as any).runnerId = runnerId;
              wsRelay.addRunnerClient(runnerId, ws);
              ws.send(JSON.stringify({ type: 'runner:auth_ok', runnerId }));

              // Push PTY session list to all connected browser clients.
              // When the server restarts, browser clients reconnect and send
              // pty:list before the runner is available, receiving empty sessions.
              // Now that the runner is connected, re-issue pty:list for each user
              // so browser clients receive the real session list.
              for (const userId of wsRelay.getConnectedBrowserUserIds()) {
                wsRelay.forwardBrowserMessageToRunner(runnerId, userId, undefined, {
                  type: 'pty:list',
                  data: {},
                });
              }
            } else {
              ws.close(4001, 'Invalid runner token');
            }
            return;
          }

          // Handle data persistence messages from runners
          if (data.type?.startsWith('data:')) {
            const { handleDataMessage } = await import('./services/data-handler.js');
            await handleDataMessage(wsData.runnerId!, data);
            return;
          }

          // ── WS-only runner operations (when WS_TUNNEL_ONLY=true on runner) ──

          // Heartbeat over WS
          if (data.type === 'runner:heartbeat' && wsData.runnerId && data.requestId) {
            const exists = await rm.handleHeartbeat(
              wsData.runnerId,
              data.payload ?? { activeThreadIds: [] },
            );
            if (!exists) {
              ws.send(
                JSON.stringify({
                  type: 'runner:heartbeat_response',
                  requestId: data.requestId,
                  code: 'RUNNER_NOT_FOUND',
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: 'runner:heartbeat_response',
                  requestId: data.requestId,
                  ok: true,
                  wsConnected: wsRelay.isRunnerConnected(wsData.runnerId),
                }),
              );
            }
            return;
          }

          // Task polling over WS
          if (data.type === 'runner:poll_tasks' && wsData.runnerId && data.requestId) {
            const tasks = await rm.getPendingTasks(wsData.runnerId);
            ws.send(
              JSON.stringify({
                type: 'runner:poll_tasks_response',
                requestId: data.requestId,
                tasks,
              }),
            );
            return;
          }

          // Project assignment over WS
          if (data.type === 'runner:assign_project' && wsData.runnerId && data.requestId) {
            try {
              const payload = data.payload;
              if (payload?.projectId && payload?.localPath) {
                await rm.assignProject(wsData.runnerId, {
                  projectId: payload.projectId,
                  localPath: payload.localPath,
                });
              }
              ws.send(
                JSON.stringify({
                  type: 'runner:assign_project_response',
                  requestId: data.requestId,
                  ok: true,
                }),
              );
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: 'runner:assign_project_response',
                  requestId: data.requestId,
                  ok: false,
                  error: (err as Error).message,
                }),
              );
            }
            return;
          }

          if (data.type === 'runner:agent_event') {
            if (!data.userId) return;
            wsRelay.relayToUser(data.userId, data.event);

            if (data.event?.type === 'agent:status' && data.event?.threadId) {
              threadRegistry
                .updateThreadStatus(data.event.threadId, data.event.data?.status || 'running')
                .catch(() => {});
            }
            if (data.event?.type === 'agent:result' && data.event?.threadId) {
              threadRegistry.updateThreadStatus(data.event.threadId, 'completed').catch(() => {});
            }
          }

          if (data.type === 'runner:browser_relay' && data.userId) {
            wsRelay.relayToUser(data.userId, data.data);
          }

          if (data.type === 'tunnel:response' && data.requestId) {
            const wsTunnel = await import('./services/ws-tunnel.js');
            wsTunnel.handleTunnelResponse(data);
          }
        }

        if (wsData.type === 'browser' && (wsData as any).userId) {
          const userId = (wsData as any).userId as string;
          const innerType = data.type as string;
          if (innerType?.startsWith('pty:')) {
            const projectId = data.data?.projectId;
            const forwardToRunner = (runnerId: string | null) => {
              if (runnerId) {
                wsRelay.forwardBrowserMessageToRunner(runnerId, userId, undefined, data);
              } else {
                // No runner connected — send error so the client can retry
                if (innerType === 'pty:spawn') {
                  try {
                    ws.send(
                      JSON.stringify({
                        type: 'pty:error',
                        data: {
                          ptyId: data.data?.id,
                          error: 'No runner available to handle terminal request',
                        },
                      }),
                    );
                  } catch {}
                }
                // For pty:list, do NOT send empty sessions when no runner is
                // connected. The runner may still be starting up and will push
                // real sessions once it connects (see runner:auth handler above).
                // Sending empty sessions prematurely would cause the client to
                // mark sessionsChecked=true, triggering new PTY spawns for tabs
                // that actually have live daemon sessions waiting to reconnect.
              }
            };
            if (projectId) {
              rm.findRunnerForProject(projectId)
                .then((result) => {
                  // If no runner is explicitly assigned, fall back to any connected runner
                  forwardToRunner(result?.runner.runnerId ?? wsRelay.getAnyConnectedRunnerId());
                })
                .catch(() => forwardToRunner(wsRelay.getAnyConnectedRunnerId()));
            } else {
              forwardToRunner(wsRelay.getAnyConnectedRunnerId());
            }
          }
        }
      } catch (err) {
        // Log unexpected errors — don't just ignore them
        if (err instanceof SyntaxError) {
          // Invalid JSON — ignore
        } else {
          log.error('WebSocket message handler error', {
            namespace: 'server',
            wsType: wsData.type,
            error: String(err),
          });
        }
      }
    },

    close(ws, code, reason) {
      const d = ws.data as any;

      if (d.type === 'runner') {
        log.warn('Runner WebSocket closed', {
          namespace: 'server',
          runnerId: d.runnerId ?? 'unauthenticated',
          code,
          reason: reason || 'none',
        });
      }

      // Decrement WebSocket connection counter
      if (d.ip) {
        const count = wsConnectionCounts.get(d.ip) ?? 1;
        if (count <= 1) wsConnectionCounts.delete(d.ip);
        else wsConnectionCounts.set(d.ip, count - 1);
      }

      if (d.type === 'browser' && d.userId) {
        import('./services/ws-relay.js').then((wsRelay) => {
          wsRelay.removeBrowserClient(d.userId, ws);
        });
      }
      if (d.type === 'runner' && d.runnerId) {
        import('./services/ws-relay.js').then((wsRelay) => {
          wsRelay.removeRunnerClient(d.runnerId);
        });
        // Only cancel pending requests and mark offline if the runner is NOT
        // actively polling. HTTP poll is the reliable baseline — if the runner
        // is still polling, requests will be delivered via poll even without WS.
        import('./services/http-tunnel.js').then((httpTunnel) => {
          if (!httpTunnel.isPolling(d.runnerId)) {
            import('./services/ws-tunnel.js').then((wsTunnel) => {
              wsTunnel.cancelPendingRequests(d.runnerId);
            });
            import('./services/runner-manager.js').then((rm) => {
              rm.markRunnerOffline(d.runnerId).catch(() => {});
            });
          }
        });
        // Clear stale thread-runner cache entries for this runner
        import('./services/runner-resolver.js').then((resolver) => {
          resolver.evictRunnerFromCache(d.runnerId);
        });
      }
    },
  },
});

log.info(`funny-server running on http://${HOST}:${PORT}`, {
  namespace: 'server',
});

// ── Runner status monitor (debug) ────────────────────────
// Prints runner connection state every second to help diagnose
// spurious "not connected" errors.
const RUNNER_STATUS_INTERVAL_MS = 1_000;
let runnerStatusTimer: ReturnType<typeof setInterval> | null = null;

if (process.env.NODE_ENV !== 'production') {
  runnerStatusTimer = setInterval(async () => {
    try {
      const wsRelay = await import('./services/ws-relay.js');
      const rm = await import('./services/runner-manager.js');
      const httpTunnel = await import('./services/http-tunnel.js');
      const stats = wsRelay.getRelayStats();
      const allRunners = await rm.listRunners();

      if (allRunners.length === 0 && stats.runners === 0) return; // nothing to report

      const runnerDetails = allRunners.map((r) => ({
        id: r.runnerId.slice(0, 8),
        name: r.name,
        dbStatus: r.status,
        wsConnected: wsRelay.isRunnerConnected(r.runnerId),
        polling: httpTunnel.isPolling(r.runnerId),
        lastHb: r.lastHeartbeatAt,
        threads: r.activeThreadCount,
        projects: r.assignedProjectIds.length,
      }));

      // Warn when there's a mismatch between WS and DB status
      const hasIssue = runnerDetails.some(
        (r) =>
          (r.dbStatus === 'online' && !r.wsConnected) ||
          (r.dbStatus === 'offline' && r.wsConnected),
      );

      const level = hasIssue ? 'warn' : 'info';
      log[level]('Runner status', {
        namespace: 'runner-monitor',
        wsRunners: stats.runners,
        wsBrowsers: stats.browserClients,
        runners: runnerDetails,
      });
    } catch {
      // Ignore — DB may not be ready yet
    }
  }, RUNNER_STATUS_INTERVAL_MS);
}

// ── Graceful shutdown ────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down…', { namespace: 'server' });

  // Stop runner status monitor
  if (runnerStatusTimer) clearInterval(runnerStatusTimer);

  // Force exit after 5 seconds if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    log.warn('Force exit after timeout', { namespace: 'server' });
    process.exit(1);
  }, 5000);

  // Stop accepting new connections (don't wait for in-flight)
  server.stop();

  // Close the server DB connection
  try {
    const { closeDatabase } = await import('./db/index.js');
    await closeDatabase();
  } catch {
    // Already closed or not initialized
  }

  clearTimeout(forceExit);
  log.info('Shutdown complete', { namespace: 'server' });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Catch unhandled errors — keep server alive
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — keeping server alive', {
    namespace: 'server',
    error: err?.message ?? String(err),
    stack: err?.stack,
  });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error('Unhandled rejection — keeping server alive', {
    namespace: 'server',
    error: msg,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

export { app, server };
