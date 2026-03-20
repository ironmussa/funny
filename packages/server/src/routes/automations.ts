/**
 * Automation CRUD routes for the central server.
 *
 * Handles automation data directly using the server's DB.
 * Automation triggering still requires a runner (proxied).
 */

import { DEFAULT_MODEL, DEFAULT_THREAD_MODE, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { eq, and, or, desc } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { automations, automationRuns, threads } from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';

export const automationRoutes = new Hono<ServerEnv>();

// ── Automation CRUD ──────────────────────────────────────────────

// GET /api/automations/inbox?projectId=xxx&triageStatus=xxx — must be before /:id
automationRoutes.get('/inbox', async (c) => {
  const projectId = c.req.query('projectId');
  const triageStatus = c.req.query('triageStatus');

  const conditions: ReturnType<typeof eq>[] = [
    or(eq(automationRuns.status, 'completed'), eq(automationRuns.status, 'failed')) as any,
  ];

  if (triageStatus) {
    conditions.push(eq(automationRuns.triageStatus, triageStatus));
  }
  if (projectId) {
    conditions.push(eq(automations.projectId, projectId));
  }

  const items = await db
    .select({
      run: automationRuns,
      automation: automations,
      thread: threads,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .innerJoin(threads, eq(automationRuns.threadId, threads.id))
    .where(and(...conditions))
    .orderBy(desc(automationRuns.completedAt));

  return c.json(items);
});

// GET /api/automations?projectId=xxx
automationRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');

  const filters: ReturnType<typeof eq>[] = [];
  if (projectId) {
    filters.push(eq(automations.projectId, projectId));
  }
  if (userId) {
    filters.push(eq(automations.userId, userId));
  }

  const condition = filters.length > 0 ? and(...filters) : undefined;
  const result = await db
    .select()
    .from(automations)
    .where(condition)
    .orderBy(desc(automations.createdAt));

  return c.json(result);
});

// GET /api/automations/:id
automationRoutes.get('/:id', async (c) => {
  const rows = await db
    .select()
    .from(automations)
    .where(eq(automations.id, c.req.param('id')));

  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json(rows[0]);
});

// POST /api/automations
automationRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const userId = c.get('userId') as string;

  if (!body.projectId || !body.name || !body.prompt || !body.schedule) {
    return c.json({ error: 'Missing required fields: projectId, name, prompt, schedule' }, 400);
  }

  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(automations).values({
    id,
    projectId: body.projectId,
    userId,
    name: body.name,
    prompt: body.prompt,
    schedule: body.schedule,
    model: body.model || DEFAULT_MODEL,
    mode: DEFAULT_THREAD_MODE,
    permissionMode: body.permissionMode || DEFAULT_PERMISSION_MODE,
    baseBranch: null,
    enabled: 1,
    maxRunHistory: 20,
    createdAt: now,
    updatedAt: now,
  });

  const rows = await db.select().from(automations).where(eq(automations.id, id));
  return c.json(rows[0], 201);
});

// PATCH /api/automations/:id
automationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(automations).where(eq(automations.id, id));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json();
  const updates: Record<string, any> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      if (key === 'enabled') {
        updates.enabled = value ? 1 : 0;
      } else {
        updates[key] = value;
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date().toISOString();
    await db.update(automations).set(updates).where(eq(automations.id, id));
  }

  const updated = await db.select().from(automations).where(eq(automations.id, id));
  return c.json(updated[0]);
});

// DELETE /api/automations/:id
automationRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(automations).where(eq(automations.id, id));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  await db.delete(automations).where(eq(automations.id, id));
  return c.json({ ok: true });
});

// POST /api/automations/:id/trigger — proxy to runner (needs agent execution)
automationRoutes.post('/:id/trigger', proxyToRunner);

// ── Runs ─────────────────────────────────────────────────────────

// GET /api/automations/:id/runs
automationRoutes.get('/:id/runs', async (c) => {
  const runs = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, c.req.param('id')))
    .orderBy(desc(automationRuns.startedAt));

  return c.json(runs);
});

// PATCH /api/automations/runs/:runId/triage
automationRoutes.patch('/runs/:runId/triage', async (c) => {
  const runId = c.req.param('runId');
  const body = await c.req.json();

  if (!body.triageStatus) {
    return c.json({ error: 'triageStatus is required' }, 400);
  }

  await db
    .update(automationRuns)
    .set({ triageStatus: body.triageStatus })
    .where(eq(automationRuns.id, runId));

  return c.json({ ok: true });
});
