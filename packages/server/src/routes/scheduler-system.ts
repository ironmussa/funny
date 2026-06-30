/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: route
 * @domain layer: presentation
 *
 * Cross-tenant HTTP surface consumed by the standalone scheduler
 * brain (`@funny/thread-scheduler` binary). Mounted at
 * `/api/scheduler/system/*`. Auth is `X-Scheduler-Auth` only —
 * `X-Forwarded-User` is intentionally NOT required here because the
 * brain operates over runs/threads belonging to ALL users.
 *
 * The shapes mirror the in-process `SchedulerRunRepository` and
 * `ThreadQueryAdapter` interfaces 1:1 so an `HttpSchedulerRunRepository`
 * adapter on the brain side can implement the same contracts by simple
 * fetch translation.
 */

import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { parseStoredJson } from '@funny/shared/json-validation';
import { createSchedulerRunRepository } from '@funny/shared/repositories';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { getSchedulerEventBuffer } from '../services/scheduler-event-buffer.js';
import { createDefaultThreadQuery } from '../services/scheduler-thread-query.js';
import { findAnyRunnerForUser } from '../services/runner-manager.js';
import { relayToUser } from '../services/ws-relay.js';
import { tunnelFetch } from '../services/ws-tunnel.js';
import { parseQuery } from '../validation/request.js';

export const schedulerSystemRoutes = new Hono<ServerEnv>();

const NS = 'scheduler-system-routes';

const runRepo = createSchedulerRunRepository({
  db,
  schema: schema as unknown as Parameters<typeof createSchedulerRunRepository>[0]['schema'],
  dbAll,
  dbGet,
  dbRun,
});

const threadQuery = createDefaultThreadQuery();

const dueRetriesQuerySchema = z.object({
  now: z.coerce.number().optional(),
});

const eventsQuerySchema = z.object({
  since: z.coerce.number().default(0),
  timeoutMs: z.coerce.number().default(25_000),
});

// ── Auth gate ────────────────────────────────────────────────
//
// Belt-and-suspenders. The auth middleware already permits
// `/api/scheduler/system/*` under X-Scheduler-Auth without a
// forwarded user, but a session user reaching here would also pass.
// We require the system flag explicitly so a stray session can't read
// cross-tenant data.

schedulerSystemRoutes.use('*', async (c, next) => {
  if (!c.get('isSchedulerSystem') && !c.get('isScheduler')) {
    return c.json({ error: 'Scheduler auth required' }, 401);
  }
  return next();
});

// ── Reads ────────────────────────────────────────────────────

schedulerSystemRoutes.get('/candidates', async (c) => {
  try {
    const threads = await threadQuery.listEligibleCandidates();
    return c.json({ threads });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('candidates failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.get('/terminal-thread-ids', async (c) => {
  try {
    const ids = [...(await threadQuery.listTerminalThreadIds())];
    return c.json({ ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('terminal-thread-ids failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.get('/threads/:id', async (c) => {
  try {
    const thread = await threadQuery.getThreadById(c.req.param('id'));
    return c.json({ thread });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('threads/:id failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.get('/runs', async (c) => {
  try {
    const runs = await runRepo.listActiveRuns();
    return c.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.get('/runs/due-retries', async (c) => {
  const parsed = parseQuery(c, dueRetriesQuerySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const now = parsed.value.now ?? Date.now();
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

schedulerSystemRoutes.get('/runs/:threadId', async (c) => {
  try {
    const run = await runRepo.getRun(c.req.param('threadId'));
    return c.json({ run: run ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs/:threadId failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.get('/dependencies', async (c) => {
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

const claimSchema = z.object({
  threadId: z.string().min(1),
  userId: z.string().min(1),
  now: z.number().optional(),
});

const patchRunSchema = z.object({
  setPipelineRunId: z.string().min(1).optional(),
  setRetry: z
    .object({
      attempt: z.number(),
      nextRetryAtMs: z.number(),
      lastError: z.string(),
    })
    .optional(),
  touchLastEvent: z.number().optional(),
  addTokens: z.number().optional(),
});

const dependencySchema = z.object({
  threadId: z.string().min(1),
  blockedBy: z.string().min(1),
});

const dispatchSchema = z.object({
  threadId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string().optional(),
  pipelineName: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

const cancelSchema = z.object({
  userId: z.string().min(1),
});

const emitSchema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

const runnerDispatchResponseSchema = z.object({
  pipelineRunId: z.string().optional(),
});

schedulerSystemRoutes.post('/runs', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'threadId and userId required' }, 400);
  }
  const body = parsed.data;
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

schedulerSystemRoutes.delete('/runs/:threadId', async (c) => {
  try {
    await runRepo.release(c.req.param('threadId'));
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('runs release failed', { namespace: NS, error: message });
    return c.json({ error: message }, 500);
  }
});

schedulerSystemRoutes.patch('/runs/:threadId', async (c) => {
  const threadId = c.req.param('threadId');
  const raw = await c.req.json().catch(() => null);
  const parsed = patchRunSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const body = parsed.data;
  try {
    if (typeof body.setPipelineRunId === 'string') {
      await runRepo.setPipelineRunId(threadId, body.setPipelineRunId);
    }
    if (body.setRetry) {
      const r = body.setRetry;
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

schedulerSystemRoutes.post('/dependencies', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = dependencySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'threadId and blockedBy required' }, 400);
  }
  const body = parsed.data;
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

schedulerSystemRoutes.delete('/dependencies', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = dependencySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'threadId and blockedBy required' }, 400);
  }
  const body = parsed.data;
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

schedulerSystemRoutes.post('/dispatch', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const validated = dispatchSchema.safeParse(raw);
  if (!validated.success) {
    return c.json({ error: 'threadId and userId required' }, 400);
  }
  const body = validated.data;

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
  if (body.inputs) payload.inputs = body.inputs;

  let response: { status: number; body: string | null };
  try {
    response = await tunnelFetch(runnerId, {
      method: 'POST',
      path: '/api/scheduler/dispatch',
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

  const parsed = response.body
    ? parseStoredJson(runnerDispatchResponseSchema, response.body, 'runner dispatch response')
    : { ok: true as const, value: {} };
  if (!parsed.ok) {
    return c.json({ ok: false, error: { message: parsed.error } }, 502);
  }
  if (!parsed.value.pipelineRunId) {
    return c.json({ ok: false, error: { message: 'runner missing pipelineRunId' } }, 502);
  }

  return c.json({ ok: true, pipelineRunId: parsed.value.pipelineRunId });
});

// POST /api/scheduler/system/cancel/:pipelineRunId — body: { userId }
schedulerSystemRoutes.post('/cancel/:pipelineRunId', async (c) => {
  const pipelineRunId = c.req.param('pipelineRunId');
  const raw = await c.req.json().catch(() => null);
  const parsed = cancelSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'userId required' }, 400);
  }
  const body = parsed.data;

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
      path: `/api/scheduler/cancel/${pipelineRunId}`,
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
// / scheduler:tick events through the server's WS relay. `userId='*'`
// is interpreted as a broadcast (matching the in-process emitter's '*' tick
// handling — currently a no-op on the relay side).

schedulerSystemRoutes.post('/emit', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = emitSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'userId and type required' }, 400);
  }
  const body = parsed.data;
  if (body.userId !== '*') {
    relayToUser(body.userId, { type: body.type, ...(body.data ?? {}) });
  }
  // '*' broadcasts are silently dropped today — same as the in-process emitter.
  return c.json({ ok: true });
});

// ── Events long-poll ─────────────────────────────────────────

schedulerSystemRoutes.get('/events', async (c) => {
  const parsed = parseQuery(c, eventsQuerySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { since, timeoutMs } = parsed.value;

  if (!Number.isFinite(since) || since < 0) return c.json({ error: 'Invalid since' }, 400);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    return c.json({ error: 'timeoutMs must be 0..60000' }, 400);
  }

  const buffer = getSchedulerEventBuffer();
  const result = await buffer.waitForEvents(since, timeoutMs);
  return c.json(result);
});
