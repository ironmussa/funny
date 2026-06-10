/**
 * @domain subdomain: Shared Kernel
 * @domain type: bounded-context
 * @domain layer: infrastructure
 *
 * Standalone runtime entry point — stateless runner mode.
 *
 * The runtime is stateless: it has no database and no auth of its own.
 * It connects to a central server via TEAM_SERVER_URL to receive work
 * and proxy data persistence over WebSocket.
 *
 * Required env vars:
 *   TEAM_SERVER_URL    — URL of the central server (e.g. https://funny.example.com)
 *   RUNNER_AUTH_SECRET  — Shared secret for runner ↔ server authentication
 */

// On Windows, bun --watch forks worker processes — each has its own globalThis.
// Ghost sockets from previous workers can block the port.
if (process.platform === 'win32') {
  await import('./kill-port.js');
}

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import { initRuntime } from './app/init-runtime.js';
import { registerRoutes } from './app/register-routes.js';
import { setupMiddleware } from './app/setup-middleware.js';
import { registerSystemRoutes } from './app/system-routes.js';
import { log } from './lib/logger.js';
import { shutdownManager, ShutdownPhase } from './services/shutdown-manager.js';

// Strip CLAUDECODE early so the Agent SDK never detects a "nested session",
// even if the runner was started from inside a Claude Code terminal.
// Use both delete and explicit empty-string: Bun's process.env Proxy doesn't
// always propagate `delete` to the real OS environ for child processes.
delete process.env.CLAUDECODE;
process.env.CLAUDECODE = '';
delete process.env.CLAUDECODE;

// Validate required env vars
if (!process.env.TEAM_SERVER_URL) {
  console.error(
    'ERROR: TEAM_SERVER_URL is required for standalone runner mode.\n' +
      'The runtime is stateless and must connect to a central server.\n\n' +
      'Example:\n' +
      '  TEAM_SERVER_URL=http://localhost:3001 RUNNER_AUTH_SECRET=secret bun run src/index.ts\n',
  );
  process.exit(1);
}

const port = Number(process.env.RUNNER_PORT) || 3003;
// Security: in WS-tunnel-only mode every request arrives via the Socket.IO
// tunnel, so the direct HTTP port does not need to be network-reachable.
// Default it to loopback to avoid exposing the runtime API on all interfaces
// — that port trusts forwarded-identity headers signed with the shared
// RUNNER_AUTH_SECRET, which every runner holds, so a reachable port lets any
// secret-holder impersonate users (see forwarded-identity trust-boundary
// note). An explicit RUNNER_HOST still wins for operators who need otherwise.
const wsTunnelOnly = process.env.WS_TUNNEL_ONLY === 'true' || process.env.WS_TUNNEL_ONLY === '1';
const host = process.env.RUNNER_HOST || (wsTunnelOnly ? '127.0.0.1' : '0.0.0.0');
const clientPort = Number(process.env.CLIENT_PORT) || 5173;
const corsOrigin = process.env.CORS_ORIGIN;

// Resolve client dist directory (works both in dev and when installed via npm)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

// Build the Hono app with all routes and middleware.
const app = new Hono();
setupMiddleware(app, { clientPort, corsOrigin });
registerSystemRoutes(app);
registerRoutes(app);

if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  app.get('*', async (c) => {
    return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
}

// Clean up previous instance on bun --watch restarts.
const prev = (globalThis as any).__bunServer;
const prevCleanup = (globalThis as any).__bunCleanup as (() => Promise<void>) | undefined;
if (prev) {
  prev.stop(true);
  if (prevCleanup) await prevCleanup();
  log.info('Cleaned up previous instance (watch restart)', { namespace: 'server' });
}

// Initialize (service provider, handlers, team mode connection)
await initRuntime(app);

const server = Bun.serve({
  port,
  hostname: host,
  reusePort: true,
  fetch(req: Request) {
    return app.fetch(req);
  },
});

// ── Shutdown registry ──────────────────────────────────────────
shutdownManager.register('http-server', () => server.stop(true), ShutdownPhase.SERVER);

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

// Store for next --watch restart
(globalThis as any).__bunServer = server;
(globalThis as any).__bunCleanup = () => shutdownManager.run('hotReload');

// Graceful shutdown
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down...', { namespace: 'server' });

  const forceExit = setTimeout(() => {
    log.warn('Force exit after timeout', { namespace: 'server' });
    process.exit(1);
  }, 5000);

  await shutdownManager.run('hard');
  clearTimeout(forceExit);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Catch unhandled errors
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

log.info(
  `Runner listening on http://${host}:${server.port} (stateless, server: ${process.env.TEAM_SERVER_URL})`,
  {
    namespace: 'server',
    port: server.port,
    host,
  },
);
