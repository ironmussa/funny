import { eq, and, or, desc, lte, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

// ── Schedule helpers ─────────────────────────────────────────────

export function parseIntervalMs(schedule: string): number {
  const match = schedule.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error(`Invalid schedule: ${schedule}`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Invalid schedule unit: ${unit}`);
  }
}

export function computeNextRunAt(schedule: string, fromTime?: string): string {
  const base = fromTime ? new Date(fromTime).getTime() : Date.now();
  const intervalMs = parseIntervalMs(schedule);
  return new Date(base + intervalMs).toISOString();
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

export function createAutomation(data: {
  projectId: string;
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  mode?: string;
  permissionMode?: string;
  baseBranch?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  const nextRunAt = computeNextRunAt(data.schedule, now);

  db.insert(schema.automations).values({
    id,
    projectId: data.projectId,
    name: data.name,
    prompt: data.prompt,
    schedule: data.schedule,
    model: data.model || 'sonnet',
    mode: data.mode || 'worktree',
    permissionMode: data.permissionMode || 'autoEdit',
    baseBranch: data.baseBranch || null,
    enabled: 1,
    maxRunHistory: 20,
    nextRunAt,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getAutomation(id)!;
}

export function updateAutomation(id: string, updates: Record<string, any>) {
  updates.updatedAt = new Date().toISOString();
  // If schedule changes, recompute nextRunAt
  if (updates.schedule && !updates.nextRunAt) {
    updates.nextRunAt = computeNextRunAt(updates.schedule);
  }
  db.update(schema.automations).set(updates)
    .where(eq(schema.automations.id, id)).run();
}

export function deleteAutomation(id: string) {
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

/** Get all pending-review runs across all automations */
export function listPendingReviewRuns() {
  return db.select({
    run: schema.automationRuns,
    automation: schema.automations,
    thread: schema.threads,
  })
    .from(schema.automationRuns)
    .innerJoin(schema.automations, eq(schema.automationRuns.automationId, schema.automations.id))
    .innerJoin(schema.threads, eq(schema.automationRuns.threadId, schema.threads.id))
    .where(
      and(
        eq(schema.automationRuns.triageStatus, 'pending'),
        or(
          eq(schema.automationRuns.status, 'completed'),
          eq(schema.automationRuns.status, 'failed'),
        )
      )
    )
    .orderBy(desc(schema.automationRuns.completedAt))
    .all();
}

// ── Scheduler helpers ────────────────────────────────────────────

export function getDueAutomations() {
  const now = new Date().toISOString();
  return db.select().from(schema.automations)
    .where(
      and(
        eq(schema.automations.enabled, 1),
        lte(schema.automations.nextRunAt, now)
      )
    )
    .all();
}

export function recalculateStaleSchedules() {
  const now = new Date().toISOString();
  const stale = db.select().from(schema.automations)
    .where(
      and(
        eq(schema.automations.enabled, 1),
        or(
          isNull(schema.automations.nextRunAt),
          lte(schema.automations.nextRunAt, now)
        )
      )
    )
    .all();

  for (const automation of stale) {
    const nextRunAt = computeNextRunAt(automation.schedule);
    db.update(schema.automations)
      .set({ nextRunAt, updatedAt: new Date().toISOString() })
      .where(eq(schema.automations.id, automation.id))
      .run();
  }

  if (stale.length > 0) {
    console.log(`[automation-manager] Recalculated ${stale.length} stale schedule(s)`);
  }
}
