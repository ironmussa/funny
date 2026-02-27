/**
 * Standalone ReviewBot server.
 *
 * Runs as an independent process, receives GitHub webhooks directly,
 * and reports review results to the funny UI via the Ingest API.
 *
 * Usage:
 *   bun packages/reviewbot/src/standalone.ts
 *   bun packages/reviewbot/src/standalone.ts --port 3002
 *
 * Environment variables:
 *   REVIEWBOT_PORT          — Port to listen on (default: 3002)
 *   REVIEW_WEBHOOK_SECRET   — GitHub webhook secret for auth
 *   FUNNY_BASE_URL          — funny server URL (default: http://localhost:3001)
 *   INGEST_WEBHOOK_SECRET   — Secret for funny's Ingest API
 *   ACP_BASE_URL            — ACP server URL (default: http://localhost:4010)
 *   REVIEWBOT_MODEL         — LLM model to use (default: claude-sonnet-4-5-20250929)
 *   REVIEWBOT_REPOS         — Repo mappings: owner/repo:/path,owner/repo2:/path2
 */

import { timingSafeEqual } from 'crypto';

import { FunnyClient } from '@funny/funny-client';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { handlePRWebhook, parseRepoMappings, type PRWebhookPayload } from './webhook-handler.js';

// ── Config ───────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.REVIEW_WEBHOOK_SECRET;
const repoMappings = parseRepoMappings(process.env.REVIEWBOT_REPOS);
const funnyBaseUrl = process.env.FUNNY_BASE_URL ?? 'http://localhost:3001';
const ingestSecret = process.env.INGEST_WEBHOOK_SECRET ?? '';
const funnyClient = new FunnyClient({ baseUrl: funnyBaseUrl, secret: ingestSecret });
const acpBaseUrl = process.env.ACP_BASE_URL;
const model = process.env.REVIEWBOT_MODEL;

// ── App ──────────────────────────────────────────────────────

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'funny-reviewbot',
    repos: repoMappings.map((m) => m.repo),
    timestamp: new Date().toISOString(),
  });
});

// GitHub webhook endpoint
app.post('/webhook', async (c) => {
  // Validate webhook secret
  if (!WEBHOOK_SECRET) {
    return c.json({ error: 'Webhook secret not configured (set REVIEW_WEBHOOK_SECRET)' }, 503);
  }

  const provided = c.req.header('X-Webhook-Secret') ?? c.req.header('X-Hub-Signature-256') ?? '';
  if (
    provided.length !== WEBHOOK_SECRET.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(WEBHOOK_SECRET))
  ) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Only process pull_request events
  const githubEvent = c.req.header('X-GitHub-Event');
  if (githubEvent && githubEvent !== 'pull_request') {
    return c.json({ status: 'ok', skipped: true, reason: `Ignoring event: ${githubEvent}` }, 200);
  }

  const body = await c.req.json<PRWebhookPayload>();

  // Validate minimal payload structure
  if (!body.action || !body.number || !body.pull_request || !body.repository) {
    return c.json({ error: 'Invalid payload: missing required fields' }, 400);
  }

  try {
    const result = await handlePRWebhook(body, {
      funnyClient,
      repoMappings,
      acpBaseUrl,
      model,
    });

    if (!result) {
      return c.json(
        { status: 'ok', skipped: true, reason: 'No matching repo or ignored action' },
        200,
      );
    }

    return c.json({ status: 'ok', request_id: result.requestId }, 200);
  } catch (err: any) {
    console.error('[reviewbot] Error processing webhook:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── Start ────────────────────────────────────────────────────

const portArg = process.argv.find((_, i, arr) => arr[i - 1] === '--port');
const port = Number(portArg) || Number(process.env.REVIEWBOT_PORT) || 3002;

console.log(`\n  funny reviewbot (standalone)`);
console.log(`  ────────────────────────────`);
console.log(`  Port:         http://localhost:${port}`);
console.log(`  Webhook:      POST http://localhost:${port}/webhook`);
console.log(
  `  Webhook auth: ${WEBHOOK_SECRET ? 'configured' : 'NOT SET (set REVIEW_WEBHOOK_SECRET)'}`,
);
console.log(`  funny server: ${process.env.FUNNY_BASE_URL ?? 'http://localhost:3001'}`);
console.log(
  `  Ingest auth:  ${process.env.INGEST_WEBHOOK_SECRET ? 'configured' : 'NOT SET (set INGEST_WEBHOOK_SECRET)'}`,
);
console.log(`  ACP server:   ${acpBaseUrl ?? 'http://localhost:4010 (default)'}`);
console.log(`  Model:        ${model ?? 'claude-sonnet-4-5-20250929 (default)'}`);
console.log(`  Repos:`);
if (repoMappings.length === 0) {
  console.log(`    (none — set REVIEWBOT_REPOS=owner/repo:/path/to/repo)`);
} else {
  for (const m of repoMappings) {
    console.log(`    - ${m.repo} → ${m.path}${m.projectId ? ` (project: ${m.projectId})` : ''}`);
  }
}
console.log();

export default {
  port,
  fetch: app.fetch,
};
