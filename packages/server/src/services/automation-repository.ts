/**
 * Automation CRUD + run tracking backed by the server's database.
 * Pure data operations only — scheduler hooks live in the runtime.
 */

import { eq, and, desc, isNull } from 'drizzle-orm';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';

/** Columns an automation update may set. */
export type AutomationRowUpdate = Partial<typeof schema.automations.$inferInsert>;

/** Columns a run update may set. */
export type AutomationRunUpdate = Partial<typeof schema.automationRuns.$inferInsert>;

// ── Automation CRUD ──────────────────────────────────────────────

export async function listAutomations(projectId?: string, userId?: string) {
  const filters: ReturnType<typeof eq>[] = [];

  if (projectId) {
    filters.push(eq(schema.automations.projectId, projectId));
  }

  if (userId) {
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

/** Raw DB update — no scheduler hooks. */
export async function updateAutomationRow(id: string, updates: AutomationRowUpdate) {
  updates.updatedAt = new Date().toISOString();
  await dbRun(db.update(schema.automations).set(updates).where(eq(schema.automations.id, id)));
}

/**
 * Take a scheduled occurrence: move `next_run_at` from `stored` to `next`, as a
 * compare-and-set. False when the row no longer holds `stored`: another server
 * process took the occurrence, or the automation was rescheduled meanwhile.
 */
export async function claimOccurrence(
  id: string,
  stored: string | null,
  next: string | null,
): Promise<boolean> {
  const held =
    stored === null
      ? isNull(schema.automations.nextRunAt)
      : eq(schema.automations.nextRunAt, stored);
  const rows = await dbAll<{ id: string }>(
    db
      .update(schema.automations)
      .set({ nextRunAt: next, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.automations.id, id), held))
      .returning({ id: schema.automations.id }),
  );
  return rows.length > 0;
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

export async function updateRun(id: string, updates: AutomationRunUpdate) {
  await dbRun(
    db.update(schema.automationRuns).set(updates).where(eq(schema.automationRuns.id, id)),
  );
}

/**
 * Finish a run: `running` → `updates.status`, as a compare-and-set. Returns
 * false when the run is no longer `running` (the stale sweep or another
 * completion got there first), in which case nothing is written.
 */
export async function finishRunningRun(id: string, updates: AutomationRunUpdate): Promise<boolean> {
  const rows = await dbAll<{ id: string }>(
    db
      .update(schema.automationRuns)
      .set(updates)
      .where(and(eq(schema.automationRuns.id, id), eq(schema.automationRuns.status, 'running')))
      .returning({ id: schema.automationRuns.id }),
  );
  return rows.length > 0;
}

export async function getRunByThreadId(threadId: string) {
  return dbGet(
    db.select().from(schema.automationRuns).where(eq(schema.automationRuns.threadId, threadId)),
  );
}
