import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from 'hono/bun';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { handleError } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { autoMigrate } from './db/migrate.js';
import { closeDatabase } from './db/index.js';
import { markStaleThreadsInterrupted } from './services/thread-manager.js';
import { getAuthToken, validateToken } from './services/auth-service.js';
import { getAuthMode } from './lib/auth-mode.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { threadRoutes } from './routes/threads.js';
import { gitRoutes } from './routes/git.js';
import browseRoutes from './routes/browse.js';
import mcpRoutes from './routes/mcp.js';
import skillsRoutes from './routes/skills.js';
import pluginRoutes from './routes/plugins.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { automationRoutes } from './routes/automations.js';
import { profileRoutes } from './routes/profile.js';
import { githubRoutes } from './routes/github.js';
import { analyticsRoutes } from './routes/analytics.js';
import { ingestRoutes } from './routes/ingest.js';
import { wsBroker } from './services/ws-broker.js';
import { startScheduler, stopScheduler } from './services/automation-scheduler.js';
import { startAgent, stopAllAgents } from './services/agent-runner.js';
import * as ptyManager from './services/pty-manager.js';
import { checkClaudeBinaryAvailability, resetBinaryCache, validateClaudeBinary } from './utils/claude-binary.js';
import { getAvailableProviders, resetProviderCache, logProviderStatus } from './utils/provider-detection.js';
import { registerAllHandlers } from './services/handlers/handler-registry.js';
import type { HandlerServiceContext } from './services/handlers/types.js';
import * as tm from './services/thread-manager.js';
import * as pm from './services/project-manager.js';
import { getProviderModels } from '@funny/shared/models';

// Resolve client dist directory (works both in dev and when installed via npm)
const clientDistDir = resolve(
  import.meta.dir,
  '..', '..', 'client', 'dist'
);

const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';
const clientPort = Number(process.env.CLIENT_PORT) || 5173;
const corsOrigin = process.env.CORS_ORIGIN;
const authMode = getAuthMode();

const app = new Hono();

// Global error handler (must be set before routes)
app.onError(handleError);

// Middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim())
      : [
          `http://localhost:${clientPort}`,
          `http://127.0.0.1:${clientPort}`,
          'tauri://localhost',
          'https://tauri.localhost',
        ],
    credentials: true,
  })
);
app.use('/api/*', rateLimit({ windowMs: 60_000, max: 1000 }));

// Ingest webhook — mounted BEFORE authMiddleware (uses its own secret-based auth)
app.route('/api/ingest', ingestRoutes);

app.use('/api/*', authMiddleware);

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup status endpoint — multi-provider detection
app.get('/api/setup/status', async (c) => {
  resetProviderCache();
  resetBinaryCache();
  const providers = await getAvailableProviders();

  // Build provider info for the response
  const providerInfo: Record<string, any> = {};
  for (const [name, info] of providers) {
    providerInfo[name] = {
      available: info.available,
      sdkAvailable: info.sdkAvailable,
      cliAvailable: info.cliAvailable,
      cliPath: info.cliPath ?? null,
      cliVersion: info.cliVersion ?? null,
      error: info.error ?? null,
      models: info.available ? getProviderModels(name as any) : [],
    };
  }

  // Legacy fields for backward compatibility
  const claude = providers.get('claude');
  return c.json({
    providers: providerInfo,
    // Legacy fields
    claudeCli: {
      available: claude?.cliAvailable ?? false,
      path: claude?.cliPath ?? null,
      error: !claude?.cliAvailable ? (claude?.error ?? 'Not available') : null,
      version: claude?.cliVersion ?? null,
    },
    agentSdk: {
      available: claude?.sdkAvailable ?? false,
    },
  });
});

// Auth mode endpoint (public — client needs this before login)
app.get('/api/auth/mode', (c) => {
  return c.json({ mode: authMode });
});

// Combined bootstrap endpoint — returns auth mode + token in a single response
// Eliminates a network round trip during app initialization
app.get('/api/bootstrap', (c) => {
  const response: Record<string, unknown> = { mode: authMode };
  if (authMode === 'local') {
    response.token = getAuthToken();
  }
  // Prevent caching of auth tokens by browsers/proxies
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  return c.json(response);
});

// Mount Better Auth routes (multi mode only)
if (authMode === 'multi') {
  const { auth } = await import('./lib/auth.js');
  app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));
}

// Mount local auth routes (local mode only — token endpoint)
if (authMode === 'local') {
  app.route('/api/auth', authRoutes);
}

// Mount routes
app.route('/api/projects', projectRoutes);
app.route('/api/threads', threadRoutes);
app.route('/api/git', gitRoutes);
app.route('/api/browse', browseRoutes);
app.route('/api/mcp', mcpRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/plugins', pluginRoutes);
app.route('/api/worktrees', worktreeRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/analytics', analyticsRoutes);

// Serve static files from client build (only if dist exists)
if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', (c) => {
    return c.html(Bun.file(join(clientDistDir, 'index.html')));
  });
  console.log(`[server] Serving static files from ${clientDistDir}`);
} else {
  console.log(`[server] Client build not found at ${clientDistDir} - static serving disabled`);
}

// Auto-create tables on startup, then start server
autoMigrate();
markStaleThreadsInterrupted();
startScheduler();

// Build handler service context from existing singletons
const handlerCtx: HandlerServiceContext = {
  getThread: tm.getThread,
  updateThread: tm.updateThread,
  insertComment: tm.insertComment,
  getProject: pm.getProject,
  emitToUser: (userId, event) => wsBroker.emitToUser(userId, event),
  broadcast: (event) => wsBroker.emit(event),
  startAgent,
  log: (msg) => console.log(`[handler] ${msg}`),
};
registerAllHandlers(handlerCtx);

if (authMode === 'local') {
  getAuthToken(); // Ensure auth token file exists before accepting connections
} else {
  // Multi mode: initialize Better Auth tables and default admin
  const { initBetterAuth } = await import('./lib/auth.js');
  await initBetterAuth();
}

console.log(`[server] Auth mode: ${authMode}`);

// Detect available providers at startup
await logProviderStatus();

// Clean up previous instance on bun --watch restarts.
// globalThis persists across watch re-evaluations — modules do NOT.
// We must call the PREVIOUS run's cleanup (stored on globalThis) to close
// the old DB connection, stop old agents, etc., not the freshly-imported ones.
const prev = (globalThis as any).__bunServer;
const prevCleanup = (globalThis as any).__bunCleanup as (() => Promise<void>) | undefined;
if (prev) {
  prev.stop(true);
  if (prevCleanup) await prevCleanup();
  console.log('[server] Cleaned up previous instance (watch restart)');
}

const server = Bun.serve({
  port,
  hostname: host,
  reusePort: true, // Allow binding even if old socket is in TIME_WAIT
  async fetch(req: Request, server: any) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (authMode === 'local') {
        // Local mode: validate token from query param
        const token = url.searchParams.get('token');
        if (!token || !validateToken(token)) {
          return new Response('Unauthorized', { status: 401 });
        }
        if (server.upgrade(req, { data: { userId: '__local__' } })) return;
      } else {
        // Multi mode: validate session from cookies
        const { auth } = await import('./lib/auth.js');
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) {
          return new Response('Unauthorized', { status: 401 });
        }
        if (server.upgrade(req, { data: { userId: session.user.id } })) return;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    // All other requests handled by Hono
    return app.fetch(req);
  },
  websocket: {
    open(ws: any) {
      const userId = ws.data?.userId ?? '__local__';
      wsBroker.addClient(ws, userId);
    },
    close(ws: any) {
      wsBroker.removeClient(ws);
    },
    message(ws: any, msg: any) {
      try {
        const parsed = JSON.parse(msg.toString());
        const { type, data } = parsed;
        const userId = ws.data?.userId ?? '__local__';

        switch (type) {
          case 'pty:spawn': {
            // Validate that cwd is within a registered project for this user
            const userProjects = pm.listProjects(userId);
            const resolvedCwd = resolve(data.cwd);
            const isAllowed = userProjects.some((p: any) => {
              const projectPath = resolve(p.path);
              return resolvedCwd.startsWith(projectPath);
            });
            if (!isAllowed) {
              console.warn(`[ws] PTY spawn denied: cwd ${data.cwd} not in user's projects (userId=${userId})`);
              try { ws.send(JSON.stringify({ type: 'pty:error', data: { ptyId: data.id, error: 'Access denied: directory not in a registered project' } })); } catch {}
              break;
            }
            ptyManager.spawnPty(data.id, data.cwd, data.cols, data.rows, userId);
            break;
          }
          case 'pty:write':
            ptyManager.writePty(data.id, data.data);
            break;
          case 'pty:resize':
            ptyManager.resizePty(data.id, data.cols, data.rows);
            break;
          case 'pty:kill':
            ptyManager.killPty(data.id);
            break;
          default:
            console.warn(`[ws] Unknown message type: ${type}`);
        }
      } catch (err) {
        console.error('[ws] Error handling message:', err);
      }
    },
  },
});

// Store for next --watch restart.
// __bunCleanup captures the current run's resources so the NEXT run can clean
// up this run's agents, DB, scheduler, etc. before re-initializing.
(globalThis as any).__bunServer = server;
(globalThis as any).__bunCleanup = async () => {
  stopScheduler();
  ptyManager.killAllPtys();
  await stopAllAgents();
  closeDatabase();
};

// Graceful shutdown — release the port FIRST, then clean up everything else.
// Previous bug: server.stop() was called AFTER stopAllAgents() which could hang,
// leaving the port occupied indefinitely.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; // Prevent double-shutdown
  shuttingDown = true;
  console.log('[server] Shutting down...');

  // 1. Release the port IMMEDIATELY — this is the most critical step
  server.stop(true);

  // 2. Force exit after 5s in case cleanup hangs
  const forceExit = setTimeout(() => {
    console.warn('[server] Force exit after timeout');
    process.exit(1);
  }, 5000);

  // 3. Clean up everything else (order doesn't matter since port is already free)
  stopScheduler();
  ptyManager.killAllPtys();
  await stopAllAgents();

  // 4. Flush WAL and close the database last (other cleanup may still write)
  closeDatabase();

  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[server] Listening on http://localhost:${server.port}`);
