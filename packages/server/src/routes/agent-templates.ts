/**
 * Agent Template CRUD routes.
 *
 * Templates are global (per-user, not per-project) and only apply
 * when the harness/provider is `deepagent`.
 */

import { BUILTIN_AGENT_TEMPLATES } from '@funny/shared';
import { eq, desc, sql, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { agentTemplates, threads } from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';

export const agentTemplateRoutes = new Hono<ServerEnv>();

// ── List all templates for the current user ─────────────────
// GET /api/agent-templates
agentTemplateRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;

  // Return user's own templates + shared templates from other users
  const result = await db
    .select()
    .from(agentTemplates)
    .where(or(eq(agentTemplates.userId, userId), eq(agentTemplates.shared, true)))
    .orderBy(desc(agentTemplates.createdAt));

  // Parse JSON columns for the response
  return c.json(result.map(parseJsonColumns));
});

// ── Usage stats (thread count per template) ────────────────
// GET /api/agent-templates/stats/usage
agentTemplateRoutes.get('/stats/usage', async (c) => {
  const userId = c.get('userId') as string;

  const rows = await db
    .select({
      templateId: threads.agentTemplateId,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(threads)
    .where(eq(threads.userId, userId))
    .groupBy(threads.agentTemplateId);

  const stats: Record<string, number> = {};
  for (const row of rows) {
    if (row.templateId) stats[row.templateId] = Number(row.count);
  }
  return c.json(stats);
});

// ── Get a single template ───────────────────────────────────
// GET /api/agent-templates/:id
agentTemplateRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');

  // Check builtin templates first
  const builtin = BUILTIN_AGENT_TEMPLATES.find((t) => t.id === id);
  if (builtin) return c.json(builtin);

  const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));

  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json(parseJsonColumns(rows[0]));
});

// ── Create a new template ───────────────────────────────────
// POST /api/agent-templates
agentTemplateRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const userId = c.get('userId') as string;

  if (!body.name) {
    return c.json({ error: 'Missing required field: name' }, 400);
  }

  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(agentTemplates).values({
    id,
    userId,
    name: body.name,
    description: body.description ?? null,
    icon: body.icon ?? null,
    color: body.color ?? null,
    model: body.model ?? null,
    systemPromptMode: body.systemPromptMode ?? 'prepend',
    systemPrompt: body.systemPrompt ?? null,
    disallowedTools: toJson(body.disallowedTools),
    mcpServers: toJson(body.mcpServers),
    builtinSkillsDisabled: toJson(body.builtinSkillsDisabled),
    customSkillPaths: toJson(body.customSkillPaths),
    agentName: body.agentName ?? null,
    shared: body.shared ?? false,
    variables: toJson(body.variables),
    createdAt: now,
    updatedAt: now,
  });

  const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  return c.json(parseJsonColumns(rows[0]), 201);
});

// ── Update a template ───────────────────────────────────────
// PATCH /api/agent-templates/:id
agentTemplateRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  if (rows[0].userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json();
  const updates: Record<string, unknown> = {};

  // Scalar fields
  for (const key of [
    'name',
    'description',
    'icon',
    'color',
    'model',
    'systemPromptMode',
    'systemPrompt',
    'agentName',
    'shared',
  ] as const) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  // JSON array fields
  for (const key of [
    'disallowedTools',
    'mcpServers',
    'builtinSkillsDisabled',
    'customSkillPaths',
    'variables',
  ] as const) {
    if (body[key] !== undefined) updates[key] = toJson(body[key]);
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date().toISOString();
    await db.update(agentTemplates).set(updates).where(eq(agentTemplates.id, id));
  }

  const updated = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  return c.json(parseJsonColumns(updated[0]));
});

// ── Delete a template ───────────────────────────────────────
// DELETE /api/agent-templates/:id
agentTemplateRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  if (rows[0].userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
  return c.json({ ok: true });
});

// ── Duplicate a template ────────────────────────────────────
// POST /api/agent-templates/:id/duplicate
agentTemplateRoutes.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId') as string;
  const sourceId = c.req.param('id');

  // Support duplicating builtin templates
  const builtin = BUILTIN_AGENT_TEMPLATES.find((t) => t.id === sourceId);

  let source: Record<string, unknown>;
  if (builtin) {
    source = {
      name: builtin.name,
      description: builtin.description ?? null,
      icon: builtin.icon ?? null,
      color: builtin.color ?? null,
      model: builtin.model ?? null,
      systemPromptMode: builtin.systemPromptMode,
      systemPrompt: builtin.systemPrompt ?? null,
      disallowedTools: toJson(builtin.disallowedTools),
      mcpServers: toJson(builtin.mcpServers),
      builtinSkillsDisabled: toJson(builtin.builtinSkillsDisabled),
      customSkillPaths: toJson(builtin.customSkillPaths),
      agentName: builtin.agentName ?? null,
    };
  } else {
    const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, sourceId));
    if (!rows[0]) return c.json({ error: 'Not found' }, 404);
    source = rows[0];
  }

  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(agentTemplates).values({
    ...source,
    id,
    userId,
    name: `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  });

  const created = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  return c.json(parseJsonColumns(created[0]), 201);
});

// ── Helpers ─────────────────────────────────────────────────

const JSON_COLUMNS = [
  'disallowedTools',
  'mcpServers',
  'builtinSkillsDisabled',
  'customSkillPaths',
  'variables',
] as const;

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const col of JSON_COLUMNS) {
    const raw = result[col];
    if (typeof raw === 'string') {
      try {
        result[col] = JSON.parse(raw);
      } catch {
        result[col] = null;
      }
    }
  }
  return result;
}
