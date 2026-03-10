/**
 * @domain subdomain: Automation
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Automation
 * @domain depends: Database, AutomationScheduler
 */

import { DEFAULT_MODEL, DEFAULT_THREAD_MODE, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { eq, and, or, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, schema, dbAll, dbGet, dbRun } from '../db/index.js';

// Lazy import to avoid circular dependency (scheduler imports us)
let schedulerHooks: {
  onAutomationCreated: (a: any) => void;
  onAutomationUpdated: (a: any) => void;
  onAutomationDeleted: (id: string) => void;
} | null = null;

async function getSchedulerHooks() {
  if (!schedulerHooks) {
    const mod = await import('./automation-scheduler.js');
    schedulerHooks = {
      onAutomationCreated: mod.onAutomationCreated,
      onAutomationUpdated: mod.onAutomationUpdated,
      onAutomationDeleted: mod.onAutomationDeleted,
    };
  }
  return schedulerHooks;
}

// ── Automation CRUD ──────────────────────────────────────────────

export async function listAutomations(projectId?: string, userId?: string) {
  const filters: ReturnType<typeof eq>[] = [];

  if (projectId) {
    filters.push(eq(schema.automations.projectId, projectId));
  }

  if (userId && userId !== '__local__') {
    filters.push(eq(schema.automations.userId, userId));
  }

  const condition = filters.length > 0 ? and(...filters) : undefined;
  return dbAll(
    db
      .select()
      .from(schema.automations)
      .where(condition)
      .orderBy(desc(schema.automations.createdAt)),
  );
}

export async function getAutomation(id: string) {
  return dbGet(db.select().from(schema.automations).where(eq(schema.automations.id, id)));
}

export async function createAutomation(data: {
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  permissionMode?: string;
  userId?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();

  await dbRun(
    db.insert(schema.automations).values({
      id,
      projectId: data.projectId,
      userId: data.userId || '__local__',
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
    }),
  );

  const automation = (await getAutomation(id))!;

  // Notify scheduler to create a cron job
  const hooks = await getSchedulerHooks();
  hooks.onAutomationCreated(automation);

  return automation;
}

export async function updateAutomation(id: string, updates: Record<string, any>) {
  updates.updatedAt = new Date().toISOString();
  await dbRun(db.update(schema.automations).set(updates).where(eq(schema.automations.id, id)));

  // Notify scheduler to reschedule the cron job
  const automation = await getAutomation(id);
  if (automation) {
    const hooks = await getSchedulerHooks();
    hooks.onAutomationUpdated(automation);
  }
}

export async function deleteAutomation(id: string) {
  // Notify scheduler before deleting
  const hooks = await getSchedulerHooks();
  hooks.onAutomationDeleted(id);

  await dbRun(db.delete(schema.automations).where(eq(schema.automations.id, id)));
}

// ── Run CRUD ─────────────────────────────────────────────────────

export async function createRun(data: {
  id: string;
  automationId: string;
  threadId: string;
  status: string;
  triageStatus: string;
  startedAt: string;
}) {
  await dbRun(db.insert(schema.automationRuns).values(data));
}

export async function updateRun(id: string, updates: Record<string, any>) {
  await dbRun(
    db.update(schema.automationRuns).set(updates).where(eq(schema.automationRuns.id, id)),
  );
}

export async function listRuns(automationId: string) {
  return dbAll(
    db
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, automationId))
      .orderBy(desc(schema.automationRuns.startedAt)),
  );
}

export async function listRunningRuns() {
  return dbAll(
    db.select().from(schema.automationRuns).where(eq(schema.automationRuns.status, 'running')),
  );
}

export async function getRunByThreadId(threadId: string) {
  return dbGet(
    db.select().from(schema.automationRuns).where(eq(schema.automationRuns.threadId, threadId)),
  );
}

/** Get pending-review runs, optionally filtered by project */
export async function listPendingReviewRuns(projectId?: string) {
  return listInboxRuns({ projectId, triageStatus: 'pending' });
}

/** Get inbox runs with flexible filtering */
export async function listInboxRuns(options?: { projectId?: string; triageStatus?: string }) {
  const conditions = [
    or(eq(schema.automationRuns.status, 'completed'), eq(schema.automationRuns.status, 'failed')),
  ];

  // Filter by triage status if specified
  if (options?.triageStatus) {
    conditions.push(eq(schema.automationRuns.triageStatus, options.triageStatus));
  }

  // Filter by project if specified
  if (options?.projectId) {
    conditions.push(eq(schema.automations.projectId, options.projectId));
  }

  return dbAll(
    db
      .select({
        run: schema.automationRuns,
        automation: schema.automations,
        thread: schema.threads,
      })
      .from(schema.automationRuns)
      .innerJoin(schema.automations, eq(schema.automationRuns.automationId, schema.automations.id))
      .innerJoin(schema.threads, eq(schema.automationRuns.threadId, schema.threads.id))
      .where(and(...conditions))
      .orderBy(desc(schema.automationRuns.completedAt)),
  );
}
