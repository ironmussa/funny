import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { authMiddleware } from '../middleware/auth.js';
import { handleError } from '../middleware/error-handler.js';
import { defaultRateLimit } from '../middleware/rate-limit.js';
import { tracingMiddleware } from '../middleware/tracing.js';
import { ingestRoutes } from '../routes/ingest.js';

interface Options {
  /** Client dev server port for CORS (default: 5173) */
  clientPort: number;
  /** Custom CORS origin (comma-separated) */
  corsOrigin: string | undefined;
}

/**
 * Wires the global middleware stack: error handler, request logger, secure
 * headers, CORS, default rate limit, tracing, ingest passthrough, then
 * runner auth. Order matters and matches the original sequence in app.ts.
 */
export function setupMiddleware(app: Hono, { clientPort, corsOrigin }: Options): void {
  app.onError(handleError);

  app.use('*', honoLogger());
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
            return false as unknown as string;
          },
      credentials: true,
    }),
  );
  app.use('/api/*', defaultRateLimit());
  app.use('/api/*', tracingMiddleware);
  app.route('/api/ingest', ingestRoutes);

  // Auth middleware: validates X-Runner-Auth from server proxy, or direct sessions
  app.use('/api/*', authMiddleware);
}
