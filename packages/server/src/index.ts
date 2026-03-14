/**
 * Unified server entry point.
 *
 * The server ALWAYS initializes its own DB and mounts its own data routes.
 * Filesystem/git/agent operations are proxied to a runner.
 * In local mode (default), an in-process runner is auto-started.
 * Set LOCAL_RUNNER=false for pure server deployments with remote runners only.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { ServerEnv } from './lib/types.js';

/** Data attached to each WebSocket connection. */
type WSData = {
  type: 'browser' | 'runner';
  req?: Request;
  userId?: string;
  runnerId?: string;
  organizationId?: string | null;
  isTranscribe?: boolean;
};

import { log } from './lib/logger.js';
import { authMiddleware, setAuthInstance } from './middleware/auth.js';

// Whether to start a local in-process runner (default: true)
const useLocalRunner = process.env.LOCAL_RUNNER !== 'false';

// ── Init ────────────────────────────────────────────────

let runtimeApp: Awaited<
  ReturnType<typeof import('@ironmussa/funny-runtime/app').createRuntimeApp>
> | null = null;

// Auth instance — populated during init, used by middleware and route handlers.
// Uses `any` because the runtime and server auth instances have slightly different types
// (different access control statements, different plugin configurations).
let authInstance: any;

// Ensure a RUNNER_AUTH_SECRET exists (auto-generate for local mode)
if (!process.env.RUNNER_AUTH_SECRET) {
  if (useLocalRunner) {
    const crypto = await import('crypto');
    process.env.RUNNER_AUTH_SECRET = crypto.randomUUID();
  } else {
    log.error('RUNNER_AUTH_SECRET is required when LOCAL_RUNNER=false. Set it in your .env file.', {
      namespace: 'server',
    });
    process.exit(1);
  }
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

// Purge stale offline runners from previous sessions
const { purgeOfflineRunners } = await import('./services/runner-manager.js');
await purgeOfflineRunners();

// ── Start local runner if enabled ───────────────────────
if (useLocalRunner) {
  const { createRuntimeApp } = await import('@ironmussa/funny-runtime/app');
  const { getConnection } = await import('./db/index.js');
  runtimeApp = await createRuntimeApp({
    skipStaticServing: true, // Server handles static files
    skipAuthSetup: true, // Server handles all auth (Better Auth)
    skipDbInit: true, // Server owns the DB now
    dbConnection: getConnection()!,
  });
  await runtimeApp.init();
  const { setLocalRunnerFetch } = await import('./lib/local-runner.js');
  setLocalRunnerFetch(runtimeApp.app.fetch.bind(runtimeApp.app));
  log.info('Local runner started in-process', { namespace: 'server' });
}

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use('*', cors({ origin: corsOrigins, credentials: true }));
app.use('*', logger());

// Health check (before auth)
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    mode: useLocalRunner ? 'local' : 'remote-runners',
    timestamp: new Date().toISOString(),
  });
});

// Bootstrap endpoint (public — minimal, no token)
app.get('/api/bootstrap', (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  return c.json({});
});

// ── Public routes (before auth middleware) ────────────────
const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('./routes/invite-links.js');
app.route('/api/invite-links', inviteLinkPublicRoutes);

// Better Auth routes
app.on(['POST', 'GET'], '/api/auth/*', (c) => authInstance.handler(c.req.raw));

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
app.route('/api/invite-links', inviteLinkRoutes);

// Setup status — delegate to local runner if available, otherwise stub
app.get('/api/setup/status', async (c) => {
  if (runtimeApp) {
    // Forward to runtime for real provider detection
    const userId = c.get('userId') || '';
    const userRole = c.get('userRole') || 'user';
    const orgId = c.get('organizationId') || '';
    const orgName = c.get('organizationName') || '';

    const headers = new Headers(c.req.raw.headers);
    headers.set('X-Forwarded-User', userId);
    headers.set('X-Forwarded-Role', userRole);
    if (orgId) headers.set('X-Forwarded-Org', orgId);
    if (orgName) headers.set('X-Forwarded-Org-Name', orgName);

    const forwardedReq = new Request(c.req.raw.url, {
      method: 'GET',
      headers,
    });

    return runtimeApp.app.fetch(forwardedReq);
  }

  return c.json({
    providers: {},
    claudeCli: { available: true, path: null, error: null, version: null },
    agentSdk: { available: true },
  });
});

// ── Proxy catch-all: forward remaining API requests to runner ──
if (useLocalRunner && runtimeApp) {
  // Local runner: forward directly to in-process runtime
  const localRuntime = runtimeApp;
  app.all('/api/*', async (c) => {
    const userId = c.get('userId') || '';
    const userRole = c.get('userRole') || 'user';
    const orgId = c.get('organizationId') || '';
    const orgName = c.get('organizationName') || '';

    const headers = new Headers(c.req.raw.headers);
    headers.set('X-Forwarded-User', userId);
    headers.set('X-Forwarded-Role', userRole);
    if (orgId) headers.set('X-Forwarded-Org', orgId);
    if (orgName) headers.set('X-Forwarded-Org-Name', orgName);

    const forwardedReq = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error -- Bun supports duplex
      duplex: c.req.raw.body ? 'half' : undefined,
    });

    return localRuntime.app.fetch(forwardedReq);
  });
} else {
  // Remote runners: proxy via WebSocket tunnel or direct HTTP
  const { proxyToRunner } = await import('./middleware/proxy.js');
  app.all('/api/*', proxyToRunner);
}

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
const HOST = process.env.HOST || (useLocalRunner ? '127.0.0.1' : '0.0.0.0');

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  reusePort: true,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (useLocalRunner && runtimeApp) {
      // Local runner: handle WS with runtime's auth + handlers
      if (url.pathname === '/ws' || url.pathname === '/ws/transcribe') {
        const wsData = await runtimeApp.authenticateWs(req);
        if (!wsData) return new Response('Unauthorized', { status: 401 });
        if (server.upgrade(req, { data: { type: 'browser', ...wsData } as any })) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
    } else {
      // Remote runners: handle WS for browsers and runners
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, {
          data: { type: 'browser', req } as any,
        });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      if (url.pathname === '/ws/runner' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, {
          data: { type: 'runner' } as any,
        });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }
    }

    return app.fetch(req, { IP: server.requestIP(req) });
  },
  websocket: {
    async open(ws) {
      const wsData = ws.data as unknown as WSData;

      if (useLocalRunner && runtimeApp) {
        // Local runner: delegate to runtime WS handler
        runtimeApp.websocket.open(ws);
        return;
      }

      // Remote runners
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

      if (useLocalRunner && runtimeApp) {
        await runtimeApp.websocket.message(ws, message);
        return;
      }

      // Remote runner relay logic
      try {
        const data = JSON.parse(typeof message === 'string' ? message : message.toString());
        const rm = await import('./services/runner-manager.js');
        const wsRelay = await import('./services/ws-relay.js');
        const threadRegistry = await import('./services/thread-registry.js');

        if (wsData.type === 'runner') {
          if (data.type === 'runner:auth' && data.token) {
            const runnerId = await rm.authenticateRunner(data.token);
            if (runnerId) {
              (ws.data as any).runnerId = runnerId;
              wsRelay.addRunnerClient(runnerId, ws);
              ws.send(JSON.stringify({ type: 'runner:auth_ok', runnerId }));
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
            if (projectId) {
              rm.findRunnerForProject(projectId)
                .then((result) => {
                  if (result) {
                    wsRelay.forwardBrowserMessageToRunner(
                      result.runner.runnerId,
                      userId,
                      undefined,
                      data,
                    );
                  }
                })
                .catch(() => {});
            } else {
              const runnerId = wsRelay.getAnyConnectedRunnerId();
              if (runnerId) {
                wsRelay.forwardBrowserMessageToRunner(runnerId, userId, undefined, data);
              }
            }
          }
        }
      } catch {
        // Invalid JSON — ignore
      }
    },

    close(ws) {
      const d = ws.data as any;

      if (useLocalRunner && runtimeApp) {
        runtimeApp.websocket.close(ws);
        return;
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
        import('./services/ws-tunnel.js').then((wsTunnel) => {
          wsTunnel.cancelPendingRequests(d.runnerId);
        });
      }
    },
  },
});

log.info(
  `funny-server running on http://${HOST}:${PORT} (${useLocalRunner ? 'local runner' : 'remote runners'})`,
  {
    namespace: 'server',
  },
);

// ── Graceful shutdown ────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down…', { namespace: 'server' });

  // Force exit after 5 seconds if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    log.warn('Force exit after timeout', { namespace: 'server' });
    process.exit(1);
  }, 5000);

  // Stop accepting new connections (don't wait for in-flight)
  server.stop();

  // Shut down the local runtime (kills child processes, PTY sessions, etc.)
  if (runtimeApp) {
    try {
      await runtimeApp.shutdown?.();
    } catch {
      // Best-effort
    }
  }

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

export { app, server };
