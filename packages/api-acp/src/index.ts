/**
 * Agent API server — exposes Claude Agent SDK as a run-based protocol.
 *
 * POST /v1/runs          — create a run (start agent query)
 * GET  /v1/runs/:id      — get run status
 * POST /v1/runs/:id/cancel — cancel an in-flight run
 * GET  /v1/models        — list available models
 *
 * No API keys needed — uses the CLI's own authentication.
 *
 * Usage:
 *   bun packages/api-acp/src/index.ts
 *   bun packages/api-acp/src/index.ts --port 8080
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { modelsRoute } from './routes/models.js';
import { runsRoute } from './routes/runs.js';
import { getAdvertisedModels } from './utils/model-resolver.js';

const app = new Hono();

// ── Middleware ────────────────────────────────────────────────

app.use('*', cors());
app.use('*', logger());

// Optional API key auth
const requiredKey = process.env.API_ACP_KEY;
if (requiredKey) {
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${requiredKey}`) {
      return c.json(
        { error: { message: 'Invalid API key', type: 'authentication_error' } },
        401,
      );
    }
    await next();
  });
}

// ── Routes ───────────────────────────────────────────────────

app.route('/v1/models', modelsRoute);
app.route('/v1/runs', runsRoute);

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'funny-api-acp' }));

// ── Start ────────────────────────────────────────────────────

const portArg = process.argv.find((_, i, arr) => arr[i - 1] === '--port');
const port = Number(portArg) || Number(process.env.API_ACP_PORT) || 4010;

console.log(`\n  funny agent api`);
console.log(`  ────────────────────────`);
console.log(`  Base URL:  http://localhost:${port}/v1`);
console.log(`  Auth:      ${requiredKey ? 'Bearer token required' : 'none (local mode)'}`);
console.log(`  Models:`);
for (const m of getAdvertisedModels()) {
  console.log(`    - ${m.id} (${m.owned_by})`);
}
console.log();

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255, // max allowed by Bun — SDK query() can take 30+ seconds to respond
};
