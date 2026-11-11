/**
 * Automation CRUD routes for the central server.
 *
 * Handles automation data directly using the server's DB. Every write keeps
 * the server-owned scheduler in sync (services/automation-scheduler.ts), and
 * manual triggers dispatch through it to the owner's runner.
 */

import type {
  AgentModel,
  AgentProvider,
  Automation,
  AutomationRun,
  AutomationSource,
  InboxThread,
  PermissionMode,
  ThreadMode,
} from '@funny/shared';
import { automationsContract as contract } from '@funny/shared/contracts/automations';
import { DEFAULT_MODEL, DEFAULT_THREAD_MODE, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { eq, and, or, desc } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { automations, automationRuns, threads } from '../db/schema.js';
import { authorizer } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';
import {
  rescheduleAutomation,
  runAutomation,
  unscheduleAutomation,
} from '../services/automation-scheduler.js';
import { fail, reply, serveEndpoint, type ErrorStatus } from '../validation/endpoint.js';

export const automationRoutes = new Hono<ServerEnv>();

// ── Rows → contract types ────────────────────────────────────────
// The columns are plain text/integer; these are the one place they become the
// contract's booleans, unions and optional fields.

type AutomationRow = typeof automations.$inferSelect;
type AutomationRunRow = typeof automationRuns.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    provider: row.provider as AgentProvider,
    model: row.model as AgentModel,
    mode: row.mode as ThreadMode,
    permissionMode: row.permissionMode as PermissionMode,
    baseBranch: row.baseBranch ?? undefined,
    enabled: row.enabled === 1,
    maxRunHistory: row.maxRunHistory,
    lastRunAt: row.lastRunAt ?? undefined,
    nextRunAt: row.nextRunAt ?? undefined,
    source: row.source as AutomationSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    threadId: row.threadId,
    status: row.status as AutomationRun['status'],
    triageStatus: row.triageStatus as AutomationRun['triageStatus'],
    hasFindings: row.hasFindings === null ? undefined : row.hasFindings === 1,
    summary: row.summary ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

function toInboxThread(row: ThreadRow): InboxThread {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    title: row.title,
    isScratch: row.isScratch === 1,
  };
}

async function readAutomation(id: string): Promise<Automation> {
  const rows = await db.select().from(automations).where(eq(automations.id, id));
  return toAutomation(rows[0]);
}

// ── Automation CRUD ──────────────────────────────────────────────
// Every endpoint requires a user: `serveEndpoint` refuses 401 without one, so
// the tenant filters below are never conditional (Security ME-5).

// GET /api/automations/inbox?projectId=xxx&triageStatus=xxx — must be before /:id
serveEndpoint(automationRoutes, contract.inbox, async ({ userId, query }) => {
  const conditions: ReturnType<typeof eq>[] = [
    or(eq(automationRuns.status, 'completed'), eq(automationRuns.status, 'failed')) as any,
    eq(automations.userId, userId),
  ];

  if (query.triageStatus) {
    conditions.push(eq(automationRuns.triageStatus, query.triageStatus));
  }
  if (query.projectId) {
    conditions.push(eq(automations.projectId, query.projectId));
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

  return reply(
    items.map((item) => ({
      run: toAutomationRun(item.run),
      automation: toAutomation(item.automation),
      thread: toInboxThread(item.thread),
    })),
  );
});

// GET /api/automations?projectId=xxx
serveEndpoint(automationRoutes, contract.list, async ({ userId, query }) => {
  const filters: ReturnType<typeof eq>[] = [eq(automations.userId, userId)];
  if (query.projectId) {
    filters.push(eq(automations.projectId, query.projectId));
  }

  const result = await db
    .select()
    .from(automations)
    .where(and(...filters))
    .orderBy(desc(automations.createdAt));

  return reply(result.map(toAutomation));
});

async function findOwnedAutomation(id: string, userId: string) {
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.userId, userId)));
  return rows[0];
}

/**
 * Moving an automation to another project re-runs the same gate as POST: the
 * run acts on that project with the owner's identity.
 */
async function canMoveToProject(
  userId: string,
  currentProjectId: string | null,
  nextProjectId: string | undefined,
): Promise<boolean> {
  if (nextProjectId === undefined || nextProjectId === currentProjectId) return true;
  return authorizer.authorize(userId, 'project', nextProjectId, 'view');
}

function buildAutomationUpdates(
  fields: Record<string, unknown>,
  enabled: boolean | undefined,
): Record<string, unknown> {
  const updates: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
  return updates;
}

// GET /api/automations/:id
serveEndpoint(automationRoutes, contract.get, async ({ userId, params }) => {
  const automation = await findOwnedAutomation(params.id, userId);
  if (!automation) return fail(404, 'Not found');
  return reply(toAutomation(automation));
});

// POST /api/automations
serveEndpoint(automationRoutes, contract.create, async ({ userId, body }) => {
  // The run will act on this project with the creator's identity — require
  // that they can see it (same 404 as a missing project).
  if (!(await authorizer.authorize(userId, 'project', body.projectId, 'view'))) {
    return fail(404, 'Project not found');
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

  await rescheduleAutomation(id);
  return reply(await readAutomation(id), 201);
});

// PATCH /api/automations/:id
serveEndpoint(automationRoutes, contract.update, async ({ userId, params, body }) => {
  const existing = await findOwnedAutomation(params.id, userId);
  if (!existing) return fail(404, 'Not found');

  const { enabled, ...fields } = body;

  if (!(await canMoveToProject(userId, existing.projectId, fields.projectId))) {
    return fail(404, 'Project not found');
  }

  const updates = buildAutomationUpdates(fields, enabled);

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date().toISOString();
    await db.update(automations).set(updates).where(eq(automations.id, params.id));
    await rescheduleAutomation(params.id);
  }

  return reply(await readAutomation(params.id));
});

// DELETE /api/automations/:id
serveEndpoint(automationRoutes, contract.remove, async ({ userId, params }) => {
  if (!(await findOwnedAutomation(params.id, userId))) return fail(404, 'Not found');

  unscheduleAutomation(params.id);
  await db.delete(automations).where(eq(automations.id, params.id));
  return reply({ ok: true });
});

// POST /api/automations/:id/trigger — run now on the owner's runner
serveEndpoint(automationRoutes, contract.trigger, async ({ userId, params }) => {
  const automation = await findOwnedAutomation(params.id, userId);
  if (!automation) return fail(404, 'Not found');

  const result = await runAutomation(automation);
  if (result.isErr()) return fail(result.error.status as ErrorStatus, result.error.message);
  return reply({ ok: true, ...result.value });
});

// ── Runs ─────────────────────────────────────────────────────────

// GET /api/automations/:id/runs
serveEndpoint(automationRoutes, contract.runs, async ({ userId, params }) => {
  if (!(await findOwnedAutomation(params.id, userId))) return fail(404, 'Not found');

  const runs = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, params.id))
    .orderBy(desc(automationRuns.startedAt));

  return reply(runs.map(toAutomationRun));
});

// PATCH /api/automations/runs/:runId/triage
serveEndpoint(automationRoutes, contract.triageRun, async ({ userId, params, body }) => {
  const owner = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .where(and(eq(automationRuns.id, params.runId), eq(automations.userId, userId)));
  if (!owner[0]) return fail(404, 'Not found');

  await db
    .update(automationRuns)
    .set({ triageStatus: body.triageStatus })
    .where(eq(automationRuns.id, params.runId));

  return reply({ ok: true });
});
