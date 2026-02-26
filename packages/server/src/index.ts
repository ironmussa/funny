// On Windows, bun --watch forks worker processes — each has its own globalThis.
// Ghost sockets from previous workers (whose child processes inherited the
// server's listening handle) can block the port. Clean them up before binding.
if (process.platform === 'win32') {
  await import('./kill-port.js');
}

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { getStatusSummary, deriveGitSyncState } from '@funny/core/git';
import { observability, observabilityShutdown } from '@funny/observability';
import {
  getProviderModels,
  getProviderModelsWithLabels,
  PROVIDER_LABELS,
  getDefaultModel,
} from '@funny/shared/models';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { autoMigrate } from './db/migrate.js';
import { getAuthMode } from './lib/auth-mode.js';
import { log } from './lib/logger.js';
import './db/index.js'; // triggers self-registration with shutdownManager
import { authMiddleware } from './middleware/auth.js';
import { handleError } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automations.js';
import browseRoutes from './routes/browse.js';
import filesRoutes from './routes/files.js';
import { gitRoutes, invalidateGitStatusCacheByProject } from './routes/git.js';
import { githubRoutes } from './routes/github.js';
import { ingestRoutes } from './routes/ingest.js';
import { logRoutes } from './routes/logs.js';
import mcpRoutes from './routes/mcp.js';
import pluginRoutes from './routes/plugins.js';
import { profileRoutes } from './routes/profile.js';
import { projectRoutes } from './routes/projects.js';
import { reviewWebhookRoutes } from './routes/review-webhook.js';
import skillsRoutes from './routes/skills.js';
import { threadRoutes } from './routes/threads.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { startAgent } from './services/agent-runner.js';
import { getAuthToken, validateToken } from './services/auth-service.js';
import { startScheduler } from './services/automation-scheduler.js';
import { registerAllHandlers } from './services/handlers/handler-registry.js';
import type { HandlerServiceContext } from './services/handlers/types.js';
import { startExternalThreadSweep } from './services/ingest-mapper.js';
import * as pm from './services/project-manager.js';
import * as ptyManager from './services/pty-manager.js';
import { saveThreadEvent } from './services/thread-event-service.js';
import {
  markStaleThreadsInterrupted,
  markStaleExternalThreadsStopped,
} from './services/thread-manager.js';
import * as tm from './services/thread-manager.js';
import { wsBroker } from './services/ws-broker.js';
import { resetBinaryCache } from './utils/claude-binary.js';
import {
  getAvailableProviders,
  resetProviderCache,
  logProviderStatus,
} from './utils/provider-detection.js';

// Resolve client dist directory (works both in dev and when installed via npm)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

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
      : (origin: string) => {
          const allowed = [
            `http://localhost:${clientPort}`,
            `http://127.0.0.1:${clientPort}`,
            'tauri://localhost',
            'https://tauri.localhost',
          ];
          if (allowed.includes(origin)) return origin;
          if (origin.startsWith('chrome-extension://')) return origin;
          return undefined;
        },
    credentials: true,
  }),
);
app.use('/api/*', rateLimit({ windowMs: 60_000, max: 1000 }));
app.use('*', observability());

// Ingest webhook — mounted BEFORE authMiddleware (uses its own secret-based auth)
app.route('/api/ingest', ingestRoutes);

// Review webhook — mounted BEFORE authMiddleware (uses webhook secret auth)
app.route('/api/review-webhook', reviewWebhookRoutes);

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
      label: PROVIDER_LABELS[name] ?? name,
      defaultModel: info.available ? getDefaultModel(name as any) : null,
      models: info.available ? getProviderModels(name as any) : [],
      modelsWithLabels: info.available ? getProviderModelsWithLabels(name as any) : [],
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
app.route('/api/files', filesRoutes);
app.route('/api/mcp', mcpRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/plugins', pluginRoutes);
app.route('/api/worktrees', worktreeRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/logs', logRoutes);

// Serve static files from client build (only if dist exists)
if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', (c) => {
    return c.html(Bun.file(join(clientDistDir, 'index.html')));
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
} else {
  log.info('Client build not found — static serving disabled', {
    namespace: 'server',
    dir: clientDistDir,
  });
}

// Auto-create tables on startup, then start server
autoMigrate();
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
  getGitStatusSummary: getStatusSummary,
  deriveGitSyncState,
  invalidateGitStatusCache: invalidateGitStatusCacheByProject,
  saveThreadEvent,
  log: (msg) => log.info(msg, { namespace: 'handler' }),
};
registerAllHandlers(handlerCtx);

if (authMode === 'local') {
  getAuthToken(); // Ensure auth token file exists before accepting connections
} else {
  // Multi mode: initialize Better Auth tables and default admin
  const { initBetterAuth } = await import('./lib/auth.js');
  await initBetterAuth();
}

log.info(`Auth mode: ${authMode}`, { namespace: 'server' });

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
  log.info('Cleaned up previous instance (watch restart)', { namespace: 'server' });
}

// Mark orphaned threads as interrupted — but only on cold starts.
// On --watch restarts, agent processes survive (stored on globalThis by the
// previous cleanup) and are adopted by the new AgentRunner. Those threads
// remain running seamlessly. Only on a true cold start (no prev instance)
// do we need to mark stale threads.
if (!prev) {
  markStaleThreadsInterrupted();
  markStaleExternalThreadsStopped();
}

// Periodic sweep: stop external threads that haven't received events in 10 minutes
startExternalThreadSweep();

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
              log.warn(`PTY spawn denied: cwd not in user's projects`, {
                namespace: 'ws',
                cwd: data.cwd,
                userId,
              });
              try {
                ws.send(
                  JSON.stringify({
                    type: 'pty:error',
                    data: {
                      ptyId: data.id,
                      error: 'Access denied: directory not in a registered project',
                    },
                  }),
                );
              } catch {}
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
            log.warn(`Unknown message type: ${type}`, { namespace: 'ws' });
        }
      } catch (err) {
        log.error('Error handling message', { namespace: 'ws', error: err });
      }
    },
  },
});

// ── Shutdown registry ──────────────────────────────────────────────
// Services self-register via shutdownManager.register() at import time.
// Here we register items that are created in index.ts itself.
import { shutdownManager, ShutdownPhase } from './services/shutdown-manager.js';

// Phase 0: release the port immediately
shutdownManager.register('http-server', () => server.stop(true), ShutdownPhase.SERVER);

// Phase 1: flush telemetry (only on hard shutdown — no need on hot reload)
shutdownManager.register(
  'observability',
  () => observabilityShutdown(),
  ShutdownPhase.SERVICES,
  false,
);

// Phase 3: Windows tree kill + exit (only on hard shutdown)
shutdownManager.register(
  'process-exit',
  () => {
    if (process.platform === 'win32') {
      try {
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${process.pid}`]);
      } catch {}
    }
    process.exit(0);
  },
  ShutdownPhase.FINAL,
  false,
);

// Store for next --watch restart.
(globalThis as any).__bunServer = server;
(globalThis as any).__bunCleanup = () => shutdownManager.run('hotReload');

// Graceful shutdown — all cleanup is handled by shutdownManager in phase order.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down...', { namespace: 'server' });

  // Force exit after 5s in case cleanup hangs
  const forceExit = setTimeout(() => {
    log.warn('Force exit after timeout', { namespace: 'server' });
    if (process.platform === 'win32') {
      try {
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${process.pid}`]);
      } catch {}
    }
    process.exit(1);
  }, 5000);

  await shutdownManager.run('hard');

  clearTimeout(forceExit);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(`Listening on http://localhost:${server.port}`, {
  namespace: 'server',
  port: server.port,
  host,
});
