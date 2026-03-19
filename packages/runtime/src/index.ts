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

import { createRuntimeApp } from './app.js';
import { log } from './lib/logger.js';
import { shutdownManager, ShutdownPhase } from './services/shutdown-manager.js';

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
const host = process.env.RUNNER_HOST || '0.0.0.0';

// Create the runtime app — stateless runner that proxies data to the server
const runtime = await createRuntimeApp({});

// Clean up previous instance on bun --watch restarts.
const prev = (globalThis as any).__bunServer;
const prevCleanup = (globalThis as any).__bunCleanup as (() => Promise<void>) | undefined;
if (prev) {
  prev.stop(true);
  if (prevCleanup) await prevCleanup();
  log.info('Cleaned up previous instance (watch restart)', { namespace: 'server' });
}

// Initialize (service provider, handlers, team mode connection)
await runtime.init();

const server = Bun.serve({
  port,
  hostname: host,
  reusePort: true,
  fetch(req: Request) {
    return runtime.app.fetch(req);
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
