import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { authMiddleware } from '../middleware/auth.js';
import { handleError } from '../middleware/error-handler.js';
import { defaultRateLimit } from '../middleware/rate-limit.js';
import { tracingMiddleware } from '../middleware/tracing.js';
import { ingestRoutes } from '../routes/ingest.js';

/**
 * Security HI-8 + HI-9: CSP/HSTS posture for any Hono app that may serve the
 * SPA dist or otherwise hand HTML to a browser. Previously the runtime used
 * `secureHeaders()` with defaults (no CSP, no HSTS) — when the runner was
 * reached directly (dev mode or `WS_TUNNEL_ONLY=false`) the SPA loaded with
 * materially weaker headers than via the server, so any XSS that slipped
 * past the server's CSP would face no second layer here.
 *
 * The connect-src policy below intentionally drops the legacy global `ws:`
 * source (HI-9): `'self'` already authorises same-origin `ws://` /
 * `wss://` upgrades, so the wildcard was both broader than needed and a
 * convenient exfil channel for any compromised script.
 */
function buildSecureHeadersConfig() {
  return {
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Monaco editor workers are bundled via Vite's `?worker` imports and
      // served from same-origin in prod; dev builds may use blob: URLs.
      workerSrc: ["'self'", 'blob:'],
      // Acknowledged limitation (M3): the SPA uses inline `style=` props +
      // Radix UI primitives that compute positioning inline at runtime.
      // Mirrors the server's config so the runtime doesn't become the
      // weaker tier.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameSrc: ["'none'"],
    },
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xContentTypeOptions: true,
  };
}

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
  app.use('*', secureHeaders(buildSecureHeadersConfig()));
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
