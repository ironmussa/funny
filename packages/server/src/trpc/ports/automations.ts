/**
 * Automations on the server's DB, for both `/api/automations` (REST) and the
 * `automations` tRPC router. Every write keeps the server-owned scheduler in
 * sync (services/automation-scheduler.ts), and manual triggers dispatch
 * through it to the owner's runner.
 *
 * Every method takes the caller's `userId`; the tenant filters below are never
 * conditional (Security ME-5).
 */

import { failure, type AutomationsPort } from '@funny/api';
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
import { DEFAULT_MODEL, DEFAULT_THREAD_MODE, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { eq, and, or, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { err, ok } from 'neverthrow';

import { db } from '../../db/index.js';
import { automations, automationRuns, threads } from '../../db/schema.js';
import { authorizer } from '../../lib/server-authorizer.js';
import {
  rescheduleAutomation,
  runAutomation,
  unscheduleAutomation,
} from '../../services/automation-scheduler.js';

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

async function findOwnedAutomation(id: string, userId: string) {
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.userId, userId)));
  return rows[0];
}

/**
 * Moving an automation to another project re-runs the same gate as create:
 * the run acts on that project with the owner's identity.
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

const notFound = () => err(failure(404, 'Not found'));

export const automationsPort: AutomationsPort = {
  async inbox(userId, query) {
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
      .select({ run: automationRuns, automation: automations, thread: threads })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .innerJoin(threads, eq(automationRuns.threadId, threads.id))
      .where(and(...conditions))
      .orderBy(desc(automationRuns.completedAt));

    return ok(
      items.map((item) => ({
        run: toAutomationRun(item.run),
        automation: toAutomation(item.automation),
        thread: toInboxThread(item.thread),
      })),
    );
  },

  async list(userId, query) {
    const filters: ReturnType<typeof eq>[] = [eq(automations.userId, userId)];
    if (query.projectId) {
      filters.push(eq(automations.projectId, query.projectId));
    }
    const result = await db
      .select()
      .from(automations)
      .where(and(...filters))
      .orderBy(desc(automations.createdAt));
    return ok(result.map(toAutomation));
  },

  async get(userId, id) {
    const automation = await findOwnedAutomation(id, userId);
    return automation ? ok(toAutomation(automation)) : notFound();
  },

  async create(userId, data) {
    // The run will act on this project with the creator's identity — require
    // that they can see it (same 404 as a missing project).
    if (!(await authorizer.authorize(userId, 'project', data.projectId, 'view'))) {
      return err(failure(404, 'Project not found'));
    }

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(automations).values({
      id,
      projectId: data.projectId,
      userId,
      name: data.name,
      prompt: data.prompt,
      schedule: data.schedule,
      model: data.model || DEFAULT_MODEL,
      mode: DEFAULT_THREAD_MODE,
      permissionMode: data.permissionMode || DEFAULT_PERMISSION_MODE,
      baseBranch: null,
      enabled: 1,
      maxRunHistory: 20,
      createdAt: now,
      updatedAt: now,
    });

    await rescheduleAutomation(id);
    return ok(await readAutomation(id));
  },

  async update(userId, id, data) {
    const existing = await findOwnedAutomation(id, userId);
    if (!existing) return notFound();

    const { enabled, ...fields } = data;
    if (!(await canMoveToProject(userId, existing.projectId, fields.projectId))) {
      return err(failure(404, 'Project not found'));
    }

    const updates = buildAutomationUpdates(fields, enabled);
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date().toISOString();
      await db.update(automations).set(updates).where(eq(automations.id, id));
      await rescheduleAutomation(id);
    }
    return ok(await readAutomation(id));
  },

  async remove(userId, id) {
    if (!(await findOwnedAutomation(id, userId))) return notFound();
    unscheduleAutomation(id);
    await db.delete(automations).where(eq(automations.id, id));
    return ok({ ok: true as const });
  },

  async trigger(userId, id) {
    const automation = await findOwnedAutomation(id, userId);
    if (!automation) return notFound();
    const result = await runAutomation(automation);
    if (result.isErr()) return err(failure(result.error.status, result.error.message));
    return ok({ ok: true as const, ...result.value });
  },

  async runs(userId, id) {
    if (!(await findOwnedAutomation(id, userId))) return notFound();
    const runs = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, id))
      .orderBy(desc(automationRuns.startedAt));
    return ok(runs.map(toAutomationRun));
  },

  async triageRun(userId, runId, triageStatus) {
    const owner = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(and(eq(automationRuns.id, runId), eq(automations.userId, userId)));
    if (!owner[0]) return notFound();

    await db.update(automationRuns).set({ triageStatus }).where(eq(automationRuns.id, runId));
    return ok({ ok: true as const });
  },
};
