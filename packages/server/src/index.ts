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
import { wsBroker } from './services/ws-broker.js';
import { startScheduler, stopScheduler } from './services/automation-scheduler.js';
import * as ptyManager from './services/pty-manager.js';
import { checkClaudeBinaryAvailability } from './utils/claude-binary.js';

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
app.use('/api/*', authMiddleware);

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth mode endpoint (public — client needs this before login)
app.get('/api/auth/mode', (c) => {
  return c.json({ mode: authMode });
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

if (authMode === 'local') {
  getAuthToken(); // Ensure auth token file exists before accepting connections
} else {
  // Multi mode: initialize Better Auth tables and default admin
  const { initBetterAuth } = await import('./lib/auth.js');
  await initBetterAuth();
}

console.log(`[server] Auth mode: ${authMode}`);

// Check Claude CLI availability at startup
const claudeBinaryCheck = checkClaudeBinaryAvailability();
if (!claudeBinaryCheck.available) {
  console.warn('[server] WARNING: Claude CLI is not installed or not found in PATH');
  console.warn(`[server] ${claudeBinaryCheck.error}`);
  console.warn('[server] Agent features will not work until Claude CLI is installed');
  console.warn('[server] Install from: https://docs.anthropic.com/en/docs/agents/overview');
} else {
  console.log(`[server] Claude CLI: ${claudeBinaryCheck.path}`);
}

const server = Bun.serve({
  port,
  hostname: host,
  reusePort: true,
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
          case 'pty:spawn':
            ptyManager.spawnPty(data.id, data.cwd, data.cols, data.rows, userId);
            break;
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

// Graceful shutdown — close the server so the port is released immediately
function shutdown() {
  console.log('[server] Shutting down...');
  stopScheduler();
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[server] Listening on http://localhost:${server.port}`);
