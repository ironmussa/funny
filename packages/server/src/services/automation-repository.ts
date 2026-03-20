/**
 * Automation CRUD + run tracking backed by the server's database.
 * Pure data operations only — scheduler hooks live in the runtime.
 */

import { eq, and, or, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

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

/**
 * Insert an automation row. Does NOT trigger scheduler hooks —
 * the runtime's automation-manager wraps this to add scheduler notification.
 */
export async function insertAutomation(data: {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: string;
  model: string;
  mode: string;
  permissionMode: string;
  enabled: number;
  maxRunHistory: number;
  createdAt: string;
  updatedAt: string;
}) {
  await dbRun(db.insert(schema.automations).values(data));
}

/** Raw DB update — no scheduler hooks. */
export async function updateAutomationRow(id: string, updates: Record<string, any>) {
  updates.updatedAt = new Date().toISOString();
  await dbRun(db.update(schema.automations).set(updates).where(eq(schema.automations.id, id)));
}

/** Raw DB delete — no scheduler hooks. */
export async function deleteAutomationRow(id: string) {
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

export async function listPendingReviewRuns(projectId?: string) {
  return listInboxRuns({ projectId, triageStatus: 'pending' });
}

export async function listInboxRuns(options?: { projectId?: string; triageStatus?: string }) {
  const conditions = [
    or(eq(schema.automationRuns.status, 'completed'), eq(schema.automationRuns.status, 'failed')),
  ];

  if (options?.triageStatus) {
    conditions.push(eq(schema.automationRuns.triageStatus, options.triageStatus));
  }

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
