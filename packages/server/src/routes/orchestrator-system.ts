/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: route
 * @domain layer: presentation
 *
 * Cross-tenant HTTP surface consumed by the standalone orchestrator
 * brain (`@funny/thread-orchestrator` binary). Mounted at
 * `/api/orchestrator/system/*`. Auth is `X-Orchestrator-Auth` only —
 * `X-Forwarded-User` is intentionally NOT required here because the
 * brain operates over runs/threads belonging to ALL users.
 *
 * The shapes mirror the in-process `OrchestratorRunRepository` and
 * `ThreadQueryAdapter` interfaces 1:1 so an `HttpOrchestratorRunRepository`
 * adapter on the brain side can implement the same contracts by simple
 * fetch translation.
 */

import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { createOrchestratorRunRepository } from '@funny/shared/repositories';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { getOrchestratorEventBuffer } from '../services/orchestrator-event-buffer.js';
import { createDefaultThreadQuery } from '../services/orchestrator-thread-query.js';
import { findAnyRunnerForUser } from '../services/runner-manager.js';
import { relayToUser } from '../services/ws-relay.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

export const orchestratorSystemRoutes = new Hono<ServerEnv>();

const NS = 'orchestrator-system-routes';

const runRepo = createOrchestratorRunRepository({
  db,
  schema: schema as unknown as Parameters<typeof createOrchestratorRunRepository>[0]['schema'],
  dbAll,
  dbGet,
  dbRun,
});

const threadQuery = createDefaultThreadQuery();

// ── Auth gate ────────────────────────────────────────────────
//
// Belt-and-suspenders. The auth middleware already permits
// `/api/orchestrator/system/*` under X-Orchestrator-Auth without a
// forwarded user, but a session user reaching here would also pass.
// We require the system flag explicitly so a stray session can't read
// cross-tenant data.

orchestratorSystemRoutes.use('*', async (c, next) => {
  if (!c.get('isOrchestratorSystem') && !c.get('isOrchestrator')) {
    return c.json({ error: 'Orchestrator auth required' }, 401);
  }
  return next();
});

// ── Reads ────────────────────────────────────────────────────

orchestratorSystemRoutes.get('/candidates', async (c) => {
  try {
    const threads = await threadQuery.listEligibleCandidates();
    return c.json({ threads });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('candidates failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/terminal-thread-ids', async (c) => {
  try {
    const ids = [...(await threadQuery.listTerminalThreadIds())];
    return c.json({ ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('terminal-thread-ids failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/threads/:id', async (c) => {
  try {
    const thread = await threadQuery.getThreadById(c.req.param('id'));
    return c.json({ thread });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('threads/:id failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/runs', async (c) => {
  try {
    const runs = await runRepo.listActiveRuns();
    return c.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/runs/due-retries', async (c) => {
  const nowParam = c.req.query('now');
  const now = nowParam ? Number.parseInt(nowParam, 10) : Date.now();
  if (!Number.isFinite(now)) return c.json({ error: 'Invalid now' }, 400);
  try {
    const runs = await runRepo.listDueRetries(now);
    return c.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs/due-retries failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/runs/:threadId', async (c) => {
  try {
    const run = await runRepo.getRun(c.req.param('threadId'));
    return c.json({ run: run ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs/:threadId failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.get('/dependencies', async (c) => {
  // ?threadIds=t1,t2,t3
  const raw = c.req.query('threadIds') ?? '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  try {
    const map = await runRepo.listDependenciesFor(ids);
    const out: Record<string, string[]> = {};
    for (const [k, v] of map.entries()) out[k] = v;
    return c.json({ dependencies: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('dependencies failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

// ── Mutations ────────────────────────────────────────────────

interface ClaimBody {
  threadId?: string;
  userId?: string;
  now?: number;
}

orchestratorSystemRoutes.post('/runs', async (c) => {
  const body = (await c.req.json().catch(() => null)) as ClaimBody | null;
  if (!body || typeof body.threadId !== 'string' || typeof body.userId !== 'string') {
    return c.json({ error: 'threadId and userId required' }, 400);
  }
  try {
    const row = await runRepo.claim({
      threadId: body.threadId,
      userId: body.userId,
      now: typeof body.now === 'number' ? body.now : undefined,
    });
    return c.json({ run: row }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Insert race / unique violation → 409 so the brain can skip
    if (/unique|primary key|already exists/i.test(message)) {
      return c.json({ error: message }, 409);
    }
    log.error('runs claim failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.delete('/runs/:threadId', async (c) => {
  try {
    await runRepo.release(c.req.param('threadId'));
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs release failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

interface PatchRunBody {
  setPipelineRunId?: string;
  setRetry?: { attempt: number; nextRetryAtMs: number; lastError: string };
  touchLastEvent?: number;
  addTokens?: number;
}

orchestratorSystemRoutes.patch('/runs/:threadId', async (c) => {
  const threadId = c.req.param('threadId');
  const body = (await c.req.json().catch(() => null)) as PatchRunBody | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  try {
    if (typeof body.setPipelineRunId === 'string') {
      await runRepo.setPipelineRunId(threadId, body.setPipelineRunId);
    }
    if (body.setRetry) {
      const r = body.setRetry;
      if (
        typeof r.attempt !== 'number' ||
        typeof r.nextRetryAtMs !== 'number' ||
        typeof r.lastError !== 'string'
      ) {
        return c.json({ error: 'Invalid setRetry payload' }, 400);
      }
      await runRepo.setRetry({
        threadId,
        attempt: r.attempt,
        nextRetryAtMs: r.nextRetryAtMs,
        lastError: r.lastError,
      });
    }
    if (typeof body.touchLastEvent === 'number') {
      await runRepo.touchLastEvent(threadId, body.touchLastEvent);
    }
    if (typeof body.addTokens === 'number' && body.addTokens > 0) {
      await runRepo.addTokens(threadId, body.addTokens);
    }
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs patch failed', { namespace: NS, threadId, error: message });
    return c.json({ error: message }, 500);
  }
});

interface DependencyBody {
  threadId?: string;
  blockedBy?: string;
}

orchestratorSystemRoutes.post('/dependencies', async (c) => {
  const body = (await c.req.json().catch(() => null)) as DependencyBody | null;
  if (!body || typeof body.threadId !== 'string' || typeof body.blockedBy !== 'string') {
    return c.json({ error: 'threadId and blockedBy required' }, 400);
  }
  try {
    await runRepo.addDependency(body.threadId, body.blockedBy);
    return c.json({ ok: true }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unique|primary key|already exists/i.test(message)) {
      return c.json({ ok: true }); // already exists is fine
    }
    log.error('dependencies add failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

orchestratorSystemRoutes.delete('/dependencies', async (c) => {
  const body = (await c.req.json().catch(() => null)) as DependencyBody | null;
  if (!body || typeof body.threadId !== 'string' || typeof body.blockedBy !== 'string') {
    return c.json({ error: 'threadId and blockedBy required' }, 400);
  }
  try {
    await runRepo.removeDependency(body.threadId, body.blockedBy);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('dependencies remove failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

// ── Dispatch (proxy to user's runner) ────────────────────────

interface DispatchBody {
  threadId?: string;
  userId?: string;
  prompt?: string;
  pipelineName?: string;
}

orchestratorSystemRoutes.post('/dispatch', async (c) => {
  const body = (await c.req.json().catch(() => null)) as DispatchBody | null;
  if (!body || typeof body.threadId !== 'string' || typeof body.userId !== 'string') {
    return c.json({ error: 'threadId and userId required' }, 400);
  }

  const runnerId = await findAnyRunnerForUser(body.userId);
  if (!runnerId) {
    return c.json(
      { ok: false, error: { message: `no runner connected for user ${body.userId}` } },
      503,
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Forwarded-User': body.userId,
  };
  const runnerSecret = process.env.RUNNER_AUTH_SECRET;
  if (runnerSecret) headers['X-Runner-Auth'] = runnerSecret;

  const payload: Record<string, unknown> = { threadId: body.threadId };
  if (typeof body.prompt === 'string') payload.prompt = body.prompt;
  if (typeof body.pipelineName === 'string') payload.pipelineName = body.pipelineName;

  let response: { status: number; body: string | null };
  try {
    response = await tunnelFetch(runnerId, {
      method: 'POST',
      path: '/api/orchestrator/dispatch',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Dispatch tunnel error', {
      namespace: NS,
      threadId: body.threadId,
      runnerId,
      error: message,
    });
    return c.json({ ok: false, error: { message } }, 502);
  }

  if (response.status < 200 || response.status >= 300) {
    const detail = response.body ? response.body.slice(0, 500) : '';
    return c.json(
      {
        ok: false,
        error: { message: `runner HTTP ${response.status}${detail ? `: ${detail}` : ''}` },
      },
      502,
    );
  }

  let parsed: { pipelineRunId?: string };
  try {
    parsed = response.body ? JSON.parse(response.body) : {};
  } catch {
    return c.json({ ok: false, error: { message: 'Invalid runner response' } }, 502);
  }
  if (!parsed.pipelineRunId) {
    return c.json({ ok: false, error: { message: 'runner missing pipelineRunId' } }, 502);
  }

  return c.json({ ok: true, pipelineRunId: parsed.pipelineRunId });
});

// POST /api/orchestrator/system/cancel/:pipelineRunId — body: { userId }
orchestratorSystemRoutes.post('/cancel/:pipelineRunId', async (c) => {
  const pipelineRunId = c.req.param('pipelineRunId');
  const body = (await c.req.json().catch(() => null)) as { userId?: string } | null;
  if (!body || typeof body.userId !== 'string') {
    return c.json({ error: 'userId required' }, 400);
  }

  const runnerId = await findAnyRunnerForUser(body.userId);
  if (!runnerId) return c.json({ ok: true, found: false });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Forwarded-User': body.userId,
  };
  const runnerSecret = process.env.RUNNER_AUTH_SECRET;
  if (runnerSecret) headers['X-Runner-Auth'] = runnerSecret;

  try {
    await tunnelFetch(runnerId, {
      method: 'POST',
      path: `/api/orchestrator/cancel/${pipelineRunId}`,
      headers,
      body: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Cancel tunnel error', {
      namespace: NS,
      pipelineRunId,
      runnerId,
      error: message,
    });
    return c.json({ ok: false, error: { message } }, 502);
  }

  return c.json({ ok: true, found: true });
});

// ── Emit (forward user events to WS) ─────────────────────────
//
// The standalone brain calls this to push thread:claimed / thread:retry-queued
// / orchestrator:tick events through the server's WS relay. `userId='*'`
// is interpreted as a broadcast (matching the in-process emitter's '*' tick
// handling — currently a no-op on the relay side).

interface EmitBody {
  userId?: string;
  type?: string;
  data?: Record<string, unknown>;
}

orchestratorSystemRoutes.post('/emit', async (c) => {
  const body = (await c.req.json().catch(() => null)) as EmitBody | null;
  if (
    !body ||
    typeof body.userId !== 'string' ||
    typeof body.type !== 'string' ||
    !body.userId ||
    !body.type
  ) {
    return c.json({ error: 'userId and type required' }, 400);
  }
  if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null)) {
    return c.json({ error: 'data must be an object' }, 400);
  }
  if (body.userId !== '*') {
    relayToUser(body.userId, { type: body.type, ...(body.data ?? {}) });
  }
  // '*' broadcasts are silently dropped today — same as the in-process emitter.
  return c.json({ ok: true });
});

// ── Events long-poll ─────────────────────────────────────────

orchestratorSystemRoutes.get('/events', async (c) => {
  const sinceParam = c.req.query('since');
  const timeoutParam = c.req.query('timeoutMs');
  const since = sinceParam ? Number.parseInt(sinceParam, 10) : 0;
  const timeoutMs = timeoutParam ? Number.parseInt(timeoutParam, 10) : 25_000;

  if (!Number.isFinite(since) || since < 0) return c.json({ error: 'Invalid since' }, 400);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    return c.json({ error: 'timeoutMs must be 0..60000' }, 400);
  }

  const buffer = getOrchestratorEventBuffer();
  const result = await buffer.waitForEvents(since, timeoutMs);
  return c.json(result);
});
