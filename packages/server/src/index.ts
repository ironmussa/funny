/**
 * Central server entry point.
 * Lightweight coordination server for team collaboration.
 *
 * Responsibilities:
 * - User authentication (Better Auth)
 * - Project management (source of truth for team projects)
 * - Runner registration and task dispatch
 * - WebSocket relay between runners and browser clients
 *
 * Does NOT:
 * - Execute git operations
 * - Spawn Claude agents
 * - Access local filesystem repos
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
};

import { initDatabase } from './db/index.js';
import { autoMigrate } from './db/migrate.js';
import { initBetterAuth } from './lib/auth.js';
import { auth } from './lib/auth.js';
import { log } from './lib/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { proxyToRunner } from './middleware/proxy.js';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profile.js';
import { projectRoutes } from './routes/projects.js';
import { runnerRoutes } from './routes/runners.js';
import { threadRoutes } from './routes/threads.js';
import * as rm from './services/runner-manager.js';
import * as threadRegistry from './services/thread-registry.js';
import * as wsRelay from './services/ws-relay.js';

// ── Init ────────────────────────────────────────────────

await initDatabase();
await autoMigrate();
await initBetterAuth();

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use('*', cors({ origin: corsOrigins, credentials: true }));
app.use('*', logger());
app.use('*', authMiddleware);

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/runners', runnerRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/threads', threadRoutes);

// Health check
app.get('/api/health', (c) => {
  const stats = wsRelay.getRelayStats();
  return c.json({
    status: 'ok',
    service: 'funny-server',
    ...stats,
  });
});

app.get('/api/auth/mode', (c) => {
  return c.json({ mode: 'multi' }); // Central always runs in multi mode
});

// Bootstrap endpoint — tells the client this is a multi-user server
app.get('/api/bootstrap', (c) => {
  return c.json({ mode: 'multi' });
});

// Setup status — central server doesn't run agents locally, always "ready"
app.get('/api/setup/status', (c) => {
  return c.json({
    providers: {},
    claudeCli: { available: true, path: null, error: null, version: null },
    agentSdk: { available: true },
  });
});

// Proxy catch-all: forward everything else to the appropriate runner
app.all('/api/*', proxyToRunner);

// Serve static files from client build (only if dist exists)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', async (c) => {
    return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
} else {
  log.info('Client build not found — static serving disabled', {
    namespace: 'server',
    dir: clientDistDir,
  });
}

// ── Server ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '0.0.0.0';

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrades
    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      // Browser client WebSocket — authenticate via session cookie
      const upgraded = server.upgrade(req, {
        data: { type: 'browser', req } as any,
      });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    if (url.pathname === '/ws/runner' && req.headers.get('upgrade') === 'websocket') {
      // Runner WebSocket — authenticated after connection via first message
      const upgraded = server.upgrade(req, {
        data: { type: 'runner' } as any,
      });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    return app.fetch(req, { IP: server.requestIP(req) });
  },
  websocket: {
    async open(ws) {
      const wsData = ws.data as unknown as WSData;

      if (wsData.type === 'browser' && wsData.req) {
        // Authenticate browser via session cookie
        const session = await auth.api.getSession({ headers: wsData.req.headers });
        if (!session) {
          ws.close(4001, 'Unauthorized');
          return;
        }
        (ws.data as any).userId = session.user.id;
        wsRelay.addBrowserClient(session.user.id, ws);
      }
      // Runner auth happens on first message (runner:auth)
    },

    message(ws, message) {
      const wsData = ws.data as unknown as WSData;

      try {
        const data = JSON.parse(typeof message === 'string' ? message : message.toString());

        if (wsData.type === 'runner') {
          // Handle runner messages
          if (data.type === 'runner:auth' && data.token) {
            // Authenticate runner
            rm.authenticateRunner(data.token).then((runnerId) => {
              if (runnerId) {
                (ws.data as any).runnerId = runnerId;
                wsRelay.addRunnerClient(runnerId, ws);
                ws.send(JSON.stringify({ type: 'runner:auth_ok', runnerId }));
              } else {
                ws.close(4001, 'Invalid runner token');
              }
            });
            return;
          }

          // Relay agent events from runner to browser clients
          if (data.type === 'runner:agent_event' && data.userId) {
            wsRelay.relayToUser(data.userId, data.event);

            // Update thread status in the registry for status/result events
            if (data.event?.type === 'agent:status' && data.event?.threadId) {
              threadRegistry
                .updateThreadStatus(data.event.threadId, data.event.data?.status || 'running')
                .catch(() => {});
            }
            if (data.event?.type === 'agent:result' && data.event?.threadId) {
              threadRegistry.updateThreadStatus(data.event.threadId, 'completed').catch(() => {});
            }
          }

          // Relay browser-targeted responses from runner to specific user
          if (data.type === 'runner:browser_relay' && data.userId) {
            wsRelay.relayToUser(data.userId, data.data);
          }
        }

        if (wsData.type === 'browser' && (wsData as any).userId) {
          // Forward browser messages (PTY, etc.) to the appropriate runner
          const userId = (wsData as any).userId as string;
          const innerType = data.type as string;
          if (innerType?.startsWith('pty:')) {
            const projectId = data.data?.projectId;
            if (projectId) {
              // Route by project assignment
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
              // No projectId (e.g. pty:list) — forward to any connected runner
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

      if (d.type === 'browser' && d.userId) {
        wsRelay.removeBrowserClient(d.userId, ws);
      }
      if (d.type === 'runner' && d.runnerId) {
        wsRelay.removeRunnerClient(d.runnerId);
      }
    },
  },
});

log.info(`funny-server running on http://${HOST}:${PORT}`, { namespace: 'server' });

export { app, server };
