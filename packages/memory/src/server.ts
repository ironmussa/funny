/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * Standalone HTTP server for Paisley Park.
 * Runs independently — no dependency on Funny runtime or runners.
 *
 * Usage:
 *   PP_DB_URL=file:memory.db PP_PROJECT_ID=my-project bun src/server.ts
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { runConsolidation, checkAdmission } from './consolidator.js';
import { runGC } from './gc.js';
import { PaisleyPark, getPaisleyPark } from './index.js';
import type { LLMConfig } from './llm.js';
import { log } from './logger.js';
import type { SearchFilters, StorageConfig, TimelineOptions } from './types.js';

// ─── Config from env ───────────────────────────────────

const PORT = Number(process.env.PP_PORT ?? 4020);
const DB_URL = process.env.PP_DB_URL ?? 'file:memory.db';
const SYNC_URL = process.env.PP_SYNC_URL;
const AUTH_TOKEN = process.env.PP_AUTH_TOKEN;
const PROJECT_ID = process.env.PP_PROJECT_ID ?? 'default';
const PROJECT_NAME = process.env.PP_PROJECT_NAME ?? 'default';
const LLM_URL = process.env.PP_LLM_URL;
const LLM_MODEL = process.env.PP_LLM_MODEL ?? 'claude-haiku';
const LLM_API_KEY = process.env.PP_LLM_API_KEY;

function buildConfig(): StorageConfig {
  const config: StorageConfig = {
    url: DB_URL,
    syncUrl: SYNC_URL,
    authToken: AUTH_TOKEN,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
  };
  if (LLM_URL) {
    config.llm = {
      baseUrl: LLM_URL,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
    };
  }
  return config;
}

function getMemory(): PaisleyPark {
  return getPaisleyPark(buildConfig());
}

// ─── App ───────────────────────────────────────────────

const app = new Hono();

app.use('*', cors());

// ─── Health ────────────────────────────────────────────

app.get('/health', (c) => {
  const pp = getMemory();
  return c.json({
    status: 'ok',
    projectId: PROJECT_ID,
    initialized: pp.isInitialized,
    hasLLM: !!LLM_URL,
  });
});

// ─── POST /v1/recall ───────────────────────────────────

app.post('/v1/recall', async (c) => {
  const body = await c.req.json<{
    query: string;
    limit?: number;
    scope?: string;
    minConfidence?: number;
    asOf?: string;
  }>();

  if (!body.query && body.query !== '') {
    return c.json({ error: 'query is required' }, 400);
  }

  try {
    const pp = getMemory();
    const result = await pp.recall(body.query, {
      limit: body.limit,
      scope: body.scope as any,
      minConfidence: body.minConfidence,
      asOf: body.asOf,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /v1/facts ────────────────────────────────────

app.post('/v1/facts', async (c) => {
  const body = await c.req.json<{
    content: string;
    type: string;
    tags?: string[];
    confidence?: number;
    relatedTo?: string[];
    sourceAgent?: string;
    sourceOperator?: string;
  }>();

  if (!body.content || !body.type) {
    return c.json({ error: 'content and type are required' }, 400);
  }

  try {
    // Run admission filter if LLM is configured
    const config = buildConfig();
    if (config.llm) {
      const admission = await checkAdmission(config.llm, body.content);
      if (!admission.admitted) {
        return c.json(
          {
            error: 'Fact rejected by admission filter',
            reason: admission.reason,
          },
          422,
        );
      }
    }

    const pp = getMemory();
    const fact = await pp.add(body.content, {
      type: body.type as any,
      tags: body.tags,
      confidence: body.confidence,
      relatedTo: body.relatedTo,
      sourceAgent: body.sourceAgent,
      sourceOperator: body.sourceOperator,
    });
    return c.json(fact, 201);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── GET /v1/facts ─────────────────────────────────────

app.get('/v1/facts', async (c) => {
  const type = c.req.query('type');
  const includeInvalidated = c.req.query('includeInvalidated') === 'true';
  const limit = Number(c.req.query('limit')) || undefined;

  try {
    const pp = getMemory();
    const facts = await pp.search('', {
      type: type as any,
      ...(includeInvalidated ? {} : {}),
    });
    return c.json({ facts: limit ? facts.slice(0, limit) : facts });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── PATCH /v1/facts/:id/invalidate ────────────────────

app.patch('/v1/facts/:id/invalidate', async (c) => {
  const factId = c.req.param('id');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });

  try {
    const pp = getMemory();
    await pp.invalidate(factId, body.reason);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── PATCH /v1/facts/:id/evolve ────────────────────────

app.patch('/v1/facts/:id/evolve', async (c) => {
  const factId = c.req.param('id');
  const body = await c.req.json<{ update: string }>();

  if (!body.update) return c.json({ error: 'update is required' }, 400);

  try {
    const pp = getMemory();
    const fact = await pp.evolve(factId, body.update);
    return c.json(fact);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /v1/search ───────────────────────────────────

app.post('/v1/search', async (c) => {
  const body = await c.req.json<{
    query: string;
    type?: string;
    tags?: string[];
    validAt?: string;
    createdAfter?: string;
    createdBefore?: string;
    minConfidence?: number;
  }>();

  try {
    const pp = getMemory();
    const filters: SearchFilters = {};
    if (body.type) filters.type = body.type as any;
    if (body.tags?.length) filters.tags = body.tags;
    if (body.validAt) filters.validAt = body.validAt;
    if (body.createdAfter) filters.createdAfter = body.createdAfter;
    if (body.createdBefore) filters.createdBefore = body.createdBefore;
    if (body.minConfidence) filters.minConfidence = body.minConfidence;

    const facts = await pp.search(body.query ?? '', filters);
    return c.json({ facts });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── GET /v1/timeline ──────────────────────────────────

app.get('/v1/timeline', async (c) => {
  const options: TimelineOptions = {};
  const from = c.req.query('from');
  const to = c.req.query('to');
  const type = c.req.query('type');
  if (from) options.from = from;
  if (to) options.to = to;
  if (type) options.type = type as any;
  options.includeInvalidated = c.req.query('includeInvalidated') === 'true';

  try {
    const pp = getMemory();
    const facts = await pp.timeline(options);
    return c.json({ facts });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /v1/consolidate ──────────────────────────────

app.post('/v1/consolidate', async (c) => {
  const config = buildConfig();
  if (!config.llm) {
    return c.json({ error: 'LLM not configured (set PP_LLM_URL)' }, 400);
  }

  try {
    const pp = getMemory();
    await pp.init();
    const result = await runConsolidation(
      pp.getDb(),
      PROJECT_ID,
      config.llm,
      pp.getEmbeddingProvider(),
    );
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /v1/gc ───────────────────────────────────────

app.post('/v1/gc', async (c) => {
  try {
    const result = await runGC(buildConfig());
    if (result.isErr()) return c.json({ error: result.error }, 500);
    return c.json(result.value);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── Start ─────────────────────────────────────────────

log.info(`Paisley Park starting on port ${PORT}`, {
  namespace: 'memory:server',
  projectId: PROJECT_ID,
  dbUrl: DB_URL,
  syncUrl: SYNC_URL ?? 'none',
  llm: LLM_URL ?? 'disabled',
});

export default {
  port: PORT,
  fetch: app.fetch,
};
