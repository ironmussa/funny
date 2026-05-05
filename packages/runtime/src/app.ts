/**
 * Runtime Hono application factory.
 *
 * Exports `createRuntimeApp()` which builds the Hono app with all routes
 * and middleware, without starting Bun.serve(). The runtime is always a
 * standalone remote runner that connects to the central server via
 * TEAM_SERVER_URL. It has no database — all data is proxied to the server
 * via the WebSocket data channel.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import { initRuntime } from './app/init-runtime.js';
import { registerRoutes } from './app/register-routes.js';
import { setupMiddleware } from './app/setup-middleware.js';
import { registerSystemRoutes } from './app/system-routes.js';
import { log } from './lib/logger.js';

// Resolve client dist directory (works both in dev and when installed via npm)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

export interface RuntimeAppOptions {
  /** Client dev server port for CORS (default: 5173) */
  clientPort?: number;
  /** Custom CORS origin (comma-separated) */
  corsOrigin?: string;
  /** Skip static file serving */
  skipStaticServing?: boolean;
}

export interface RuntimeApp {
  /** The Hono app instance */
  app: Hono;
  /** Initialize DB, run migrations, set up auth, register handlers. */
  init(): Promise<void>;
  /** Graceful shutdown — kills child processes, PTY sessions, closes DB. */
  shutdown(): Promise<void>;
}

/**
 * Create the runtime Hono application with all routes mounted.
 * Does NOT start a server — caller is responsible for that.
 */
export async function createRuntimeApp(options: RuntimeAppOptions): Promise<RuntimeApp> {
  const clientPort = options.clientPort ?? (Number(process.env.CLIENT_PORT) || 5173);
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN;

  const app = new Hono();

  setupMiddleware(app, { clientPort, corsOrigin });
  registerSystemRoutes(app);
  registerRoutes(app);

  // Serve static files from client build
  if (!options.skipStaticServing && existsSync(clientDistDir)) {
    app.use('/*', serveStatic({ root: clientDistDir }));
    app.get('*', async (c) => {
      return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
    });
    log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
  }

  return {
    app,
    init: () => initRuntime(app),
    shutdown,
  };
}

async function shutdown(): Promise<void> {
  const { shutdownManager } = await import('./services/shutdown-manager.js');
  await shutdownManager.run('hard');
}
