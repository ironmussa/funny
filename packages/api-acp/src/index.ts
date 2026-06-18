/**
 * Agent API server — exposes Claude Agent SDK as a run-based protocol.
 *
 * POST /v1/runs          — create a run (start agent query)
 * GET  /v1/runs/:id      — get run status
 * POST /v1/runs/:id/cancel — cancel an in-flight run
 * GET  /v1/models        — list available models
 *
 * API key required by default — uses the CLI's own authentication behind it.
 *
 * Usage:
 *   bun packages/api-acp/src/index.ts
 *   bun packages/api-acp/src/index.ts --port 8080
 */

import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { log, metric } from './lib/telemetry.js';
import { modelsRoute } from './routes/models.js';
import { runsRoute } from './routes/runs.js';
import { getAdvertisedModels } from './utils/model-resolver.js';

const app = new Hono();

// ── Middleware ────────────────────────────────────────────────

const requiredKey = process.env.API_ACP_KEY;
const allowInsecureNoAuth = process.env.API_ACP_INSECURE_NO_AUTH === '1';
const allowedOrigins = (process.env.API_ACP_ALLOWED_ORIGINS ?? 'http://localhost,http://127.0.0.1')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function matchesAllowedOrigin(origin: string, allowed: string): boolean {
  if (origin === allowed) return true;
  return origin.startsWith(`${allowed}:`);
}

function hasValidBearer(authHeader: string | undefined, key: string): boolean {
  const prefix = 'Bearer ';
  if (!authHeader?.startsWith(prefix)) return false;

  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(key);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      return allowedOrigins.some((allowed) => matchesAllowedOrigin(origin, allowed))
        ? origin
        : null;
    },
  }),
);
app.use('*', logger());

app.use('/v1/*', async (c, next) => {
  if (!requiredKey) {
    if (allowInsecureNoAuth) {
      await next();
      return;
    }

    return c.json(
      {
        error: {
          message:
            'API_ACP_KEY is required. Set API_ACP_INSECURE_NO_AUTH=1 only for local development.',
          type: 'configuration_error',
        },
      },
      503,
    );
  }

  if (!hasValidBearer(c.req.header('Authorization'), requiredKey)) {
    return c.json({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401);
  }

  await next();
});

// ── Routes ───────────────────────────────────────────────────

app.route('/v1/models', modelsRoute);
app.route('/v1/runs', runsRoute);

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'funny-api-acp' }));

// ── Start ────────────────────────────────────────────────────

const portArg = process.argv.find((_, i, arr) => arr[i - 1] === '--port');
const port = Number(portArg) || Number(process.env.API_ACP_PORT) || 4010;
const hostArg = process.argv.find((_, i, arr) => arr[i - 1] === '--host');
const hostname = hostArg || process.env.API_ACP_HOST || '127.0.0.1';

log.info(
  [
    '',
    '  funny agent api',
    '  ────────────────────────',
    `  Base URL:  http://${hostname}:${port}/v1`,
    `  Auth:      ${requiredKey ? 'Bearer token required' : allowInsecureNoAuth ? 'none (explicit insecure local mode)' : 'not configured'}`,
    '  Models:',
    ...getAdvertisedModels().map((m) => `    - ${m.id} (${m.owned_by})`),
    '',
  ].join('\n'),
);

log.info('api-acp server started', {
  port,
  hostname,
  auth: !!requiredKey,
  allowInsecureNoAuth,
  models: getAdvertisedModels().length,
});
metric('server.start', 1, { type: 'sum', attributes: { port } });

export default {
  port,
  hostname,
  fetch: app.fetch,
  idleTimeout: 255, // max allowed by Bun — SDK query() can take 30+ seconds to respond
};
