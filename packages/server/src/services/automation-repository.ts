/**
 * Automation CRUD + run tracking backed by the server's database.
 * Pure data operations only — scheduler hooks live in the runtime.
 */

import { eq, and, or, desc } from 'drizzle-orm';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';

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
export async function updateAutomationRow(id: string, updates: Record<string, any>) {
  updates.updatedAt = new Date().toISOString();
  await dbRun(db.update(schema.automations).set(updates).where(eq(schema.automations.id, id)));
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

export async function getRunByThreadId(threadId: string) {
  return dbGet(
    db.select().from(schema.automationRuns).where(eq(schema.automationRuns.threadId, threadId)),
  );
}
