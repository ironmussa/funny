/**
 * Agent templates (global per user, only for the `deepagent` harness), for both
 * `/api/agent-templates` (REST) and the `agentTemplates` tRPC router. A
 * template is readable by its owner or by anyone when shared, and writable by
 * its owner only. Built-in templates can be read and duplicated, never written.
 */

import { failure, type AgentTemplatesPort } from '@funny/api';
import { BUILTIN_AGENT_TEMPLATES, type AgentTemplate } from '@funny/shared';
import type { UpdateAgentTemplateBody } from '@funny/shared/contracts/agent-templates';
import { parseStoredJson } from '@funny/shared/json-validation';
import { desc, eq, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { err, ok } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { agentTemplates, threads } from '../../db/schema.js';

type TemplateRow = typeof agentTemplates.$inferSelect;

const notFound = () => err(failure(404, 'Not found'));

/** A template is readable by its owner, or by anyone when it is marked shared. */
function canReadTemplate(row: { userId: string; shared: boolean | null }, userId: string): boolean {
  return row.userId === userId || row.shared === true;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

/** A JSON column's value; absent when it is null or not valid JSON. */
function fromJson<T>(raw: string | null): T | undefined {
  if (raw == null) return undefined;
  const parsed = parseStoredJson(z.unknown(), raw, 'agent template column');
  return parsed.ok ? ((parsed.value ?? undefined) as T | undefined) : undefined;
}

/** `null` columns become absent fields; the JSON columns are parsed. */
function toAgentTemplate(row: TemplateRow): AgentTemplate {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    model: (row.model ?? undefined) as AgentTemplate['model'],
    systemPromptMode: row.systemPromptMode as AgentTemplate['systemPromptMode'],
    systemPrompt: row.systemPrompt ?? undefined,
    disallowedTools: fromJson(row.disallowedTools),
    mcpServers: fromJson(row.mcpServers),
    builtinSkillsDisabled: fromJson(row.builtinSkillsDisabled),
    customSkillPaths: fromJson(row.customSkillPaths),
    agentName: row.agentName ?? undefined,
    shared: row.shared,
    variables: fromJson(row.variables),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function readRow(id: string): Promise<TemplateRow | undefined> {
  const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id));
  return rows[0];
}

const SCALAR_FIELDS = [
  'name',
  'description',
  'icon',
  'color',
  'model',
  'systemPromptMode',
  'systemPrompt',
  'agentName',
  'shared',
] as const;
const JSON_FIELDS = [
  'disallowedTools',
  'mcpServers',
  'builtinSkillsDisabled',
  'customSkillPaths',
  'variables',
] as const;

/** Column writes for a PATCH body: scalars as given, list fields as JSON. */
function templateUpdates(body: UpdateAgentTemplateBody): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) if (body[key] !== undefined) updates[key] = body[key];
  for (const key of JSON_FIELDS) if (body[key] !== undefined) updates[key] = toJson(body[key]);
  return updates;
}

/** The columns a duplicate copies from a built-in template. */
function builtinColumns(builtin: AgentTemplate): Record<string, unknown> {
  return {
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
}

export const agentTemplatesPort: AgentTemplatesPort = {
  async list(userId) {
    // The user's own templates + shared templates from other users.
    const rows = await db
      .select()
      .from(agentTemplates)
      .where(or(eq(agentTemplates.userId, userId), eq(agentTemplates.shared, true)))
      .orderBy(desc(agentTemplates.createdAt));
    return ok(rows.map(toAgentTemplate));
  },

  async usageStats(userId) {
    const rows = await db
      .select({ templateId: threads.agentTemplateId, count: sql<number>`count(*)`.as('count') })
      .from(threads)
      .where(eq(threads.userId, userId))
      .groupBy(threads.agentTemplateId);
    const stats: Record<string, number> = {};
    for (const row of rows) if (row.templateId) stats[row.templateId] = Number(row.count);
    return ok(stats);
  },

  async get(userId, id) {
    const builtin = BUILTIN_AGENT_TEMPLATES.find((t) => t.id === id);
    if (builtin) return ok(builtin);
    // Another user's private template is indistinguishable from a missing one.
    const row = await readRow(id);
    return row && canReadTemplate(row, userId) ? ok(toAgentTemplate(row)) : notFound();
  },

  async create(userId, data) {
    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(agentTemplates).values({
      id,
      userId,
      name: data.name,
      description: data.description ?? null,
      icon: data.icon ?? null,
      color: data.color ?? null,
      model: data.model ?? null,
      systemPromptMode: data.systemPromptMode ?? 'prepend',
      systemPrompt: data.systemPrompt ?? null,
      disallowedTools: toJson(data.disallowedTools),
      mcpServers: toJson(data.mcpServers),
      builtinSkillsDisabled: toJson(data.builtinSkillsDisabled),
      customSkillPaths: toJson(data.customSkillPaths),
      agentName: data.agentName ?? null,
      shared: data.shared ?? false,
      variables: toJson(data.variables),
      createdAt: now,
      updatedAt: now,
    });
    return ok(toAgentTemplate((await readRow(id))!));
  },

  async update(_userId, id, data) {
    const updates = templateUpdates(data);
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date().toISOString();
      await db.update(agentTemplates).set(updates).where(eq(agentTemplates.id, id));
    }
    const row = await readRow(id);
    return row ? ok(toAgentTemplate(row)) : notFound();
  },

  async remove(_userId, id) {
    await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
    return ok({ ok: true as const });
  },

  async duplicate(userId, sourceId) {
    const builtin = BUILTIN_AGENT_TEMPLATES.find((t) => t.id === sourceId);
    let source: Record<string, unknown>;
    if (builtin) {
      source = builtinColumns(builtin);
    } else {
      const row = await readRow(sourceId);
      if (!row || !canReadTemplate(row, userId)) return notFound();
      source = row;
    }

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(agentTemplates).values({
      ...(source as typeof agentTemplates.$inferInsert),
      id,
      userId,
      // A copy starts private, even when duplicated from someone's shared template.
      shared: false,
      name: `${source.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    });
    return ok(toAgentTemplate((await readRow(id))!));
  },

  async authorizeWrite(userId, id) {
    const row = await readRow(id);
    if (!row) return failure(404, 'Not found');
    return row.userId === userId ? null : failure(403, 'Forbidden');
  },
};
