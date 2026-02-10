import { eq, and, or, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

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

export function listAutomations(projectId?: string) {
  if (projectId) {
    return db.select().from(schema.automations)
      .where(eq(schema.automations.projectId, projectId))
      .orderBy(desc(schema.automations.createdAt))
      .all();
  }
  return db.select().from(schema.automations)
    .orderBy(desc(schema.automations.createdAt))
    .all();
}

export function getAutomation(id: string) {
  return db.select().from(schema.automations)
    .where(eq(schema.automations.id, id))
    .get();
}

export async function createAutomation(data: {
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  permissionMode?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();

  db.insert(schema.automations).values({
    id,
    projectId: data.projectId,
    name: data.name,
    prompt: data.prompt,
    schedule: data.schedule,
    model: data.model || 'sonnet',
    mode: 'local',
    permissionMode: data.permissionMode || 'autoEdit',
    baseBranch: null,
    enabled: 1,
    maxRunHistory: 20,
    createdAt: now,
    updatedAt: now,
  }).run();

  const automation = getAutomation(id)!;

  // Notify scheduler to create a cron job
  const hooks = await getSchedulerHooks();
  hooks.onAutomationCreated(automation);

  return automation;
}

export async function updateAutomation(id: string, updates: Record<string, any>) {
  updates.updatedAt = new Date().toISOString();
  db.update(schema.automations).set(updates)
    .where(eq(schema.automations.id, id)).run();

  // Notify scheduler to reschedule the cron job
  const automation = getAutomation(id);
  if (automation) {
    const hooks = await getSchedulerHooks();
    hooks.onAutomationUpdated(automation);
  }
}

export async function deleteAutomation(id: string) {
  // Notify scheduler before deleting
  const hooks = await getSchedulerHooks();
  hooks.onAutomationDeleted(id);

  db.delete(schema.automations).where(eq(schema.automations.id, id)).run();
}

// ── Run CRUD ─────────────────────────────────────────────────────

export function createRun(data: {
  id: string;
  automationId: string;
  threadId: string;
  status: string;
  triageStatus: string;
  startedAt: string;
}) {
  db.insert(schema.automationRuns).values(data).run();
}

export function updateRun(id: string, updates: Record<string, any>) {
  db.update(schema.automationRuns).set(updates)
    .where(eq(schema.automationRuns.id, id)).run();
}

export function listRuns(automationId: string) {
  return db.select().from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, automationId))
    .orderBy(desc(schema.automationRuns.startedAt))
    .all();
}

export function listRunningRuns() {
  return db.select().from(schema.automationRuns)
    .where(eq(schema.automationRuns.status, 'running'))
    .all();
}

export function getRunByThreadId(threadId: string) {
  return db.select().from(schema.automationRuns)
    .where(eq(schema.automationRuns.threadId, threadId))
    .get();
}

/** Get pending-review runs, optionally filtered by project */
export function listPendingReviewRuns(projectId?: string) {
  return listInboxRuns({ projectId, triageStatus: 'pending' });
}

/** Get inbox runs with flexible filtering */
export function listInboxRuns(options?: { projectId?: string; triageStatus?: string }) {
  const conditions = [
    or(
      eq(schema.automationRuns.status, 'completed'),
      eq(schema.automationRuns.status, 'failed'),
    ),
  ];

  // Filter by triage status if specified
  if (options?.triageStatus) {
    conditions.push(eq(schema.automationRuns.triageStatus, options.triageStatus));
  }

  // Filter by project if specified
  if (options?.projectId) {
    conditions.push(eq(schema.automations.projectId, options.projectId));
  }

  return db.select({
    run: schema.automationRuns,
    automation: schema.automations,
    thread: schema.threads,
  })
    .from(schema.automationRuns)
    .innerJoin(schema.automations, eq(schema.automationRuns.automationId, schema.automations.id))
    .innerJoin(schema.threads, eq(schema.automationRuns.threadId, schema.threads.id))
    .where(and(...conditions))
    .orderBy(desc(schema.automationRuns.completedAt))
    .all();
}
