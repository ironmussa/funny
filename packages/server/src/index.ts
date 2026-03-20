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

import { log } from './lib/logger.js';
import type { ServerEnv } from './lib/types.js';
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

log.info('Server initialized — DB mode: sqlite', { namespace: 'server' });

// On restart, purge all runners and their project assignments.
// No runner has an active WebSocket connection at this point, so all
// state is stale. Runners will re-register and re-assign projects on connect.
const { purgeAllRunners, purgeStaleRunners } = await import('./services/runner-manager.js');
await purgeAllRunners();
await purgeStaleRunners();

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const devClientPort = process.env.VITE_PORT || '5173';
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : [`http://localhost:${devClientPort}`, `http://127.0.0.1:${devClientPort}`];

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

// Initialize Socket.IO server with Bun-native engine
const { createSocketIOServer, closeSocketIO } = await import('./services/socketio.js');
const { engine: socketEngine } = createSocketIOServer(authInstance, corsOrigins);

const server = Bun.serve({
  // Spread Bun engine handler FIRST — provides the `websocket` property
  // for native Bun WebSocket lifecycle (open/message/close).
  ...socketEngine.handler(),
  port: PORT,
  hostname: HOST,
  reusePort: true,
  async fetch(req, server) {
    // Handle Socket.IO requests BEFORE Hono — WebSocket upgrades need
    // direct access to Bun's server.upgrade(), which returns undefined
    // (Hono always expects a Response, so it can't handle upgrades).
    const url = new URL(req.url);
    if (url.pathname.startsWith('/socket.io/')) {
      return socketEngine.handleRequest(req, server);
    }
    return app.fetch(req, { IP: server.requestIP(req) });
  },
});

log.info(`funny-server running on http://${HOST}:${PORT}`, {
  namespace: 'server',
});

// ── Runner status monitor (debug) ────────────────────────
// Socket.IO handles heartbeats natively (pingInterval/pingTimeout),
// so we only check periodically for DB↔connection state mismatches.
const RUNNER_STATUS_INTERVAL_MS = 30_000;
let runnerStatusTimer: ReturnType<typeof setInterval> | null = null;
let lastRunnerStateHash = '';

if (process.env.NODE_ENV !== 'production') {
  runnerStatusTimer = setInterval(async () => {
    try {
      const wsRelay = await import('./services/ws-relay.js');
      const rm = await import('./services/runner-manager.js');
      const stats = wsRelay.getRelayStats();
      const allRunners = await rm.listRunners();

      if (allRunners.length === 0 && stats.runners === 0) return; // nothing to report

      const runnerDetails = allRunners.map((r) => ({
        id: r.runnerId.slice(0, 8),
        name: r.name,
        dbStatus: r.status,
        connected: wsRelay.isRunnerConnected(r.runnerId),
        lastHb: r.lastHeartbeatAt,
        threads: r.activeThreadCount,
        projects: r.assignedProjectIds.length,
      }));

      // Warn when there's a mismatch between Socket.IO connection and DB status
      const hasIssue = runnerDetails.some(
        (r) =>
          (r.dbStatus === 'online' && !r.connected) || (r.dbStatus === 'offline' && r.connected),
      );

      // Only log when state changes or there's an issue
      const stateHash = JSON.stringify(
        runnerDetails.map((r) => `${r.id}:${r.dbStatus}:${r.connected}`),
      );
      if (stateHash === lastRunnerStateHash && !hasIssue) return;
      lastRunnerStateHash = stateHash;

      const level = hasIssue ? 'warn' : 'info';
      log[level]('Runner status', {
        namespace: 'runner-monitor',
        runners: stats.runners,
        browsers: stats.browserClients,
        runnerDetails,
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

  // Close Socket.IO connections
  await closeSocketIO();

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
