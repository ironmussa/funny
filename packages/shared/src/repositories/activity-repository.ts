/**
 * @domain subdomain: Activities
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for background activities (track-background-activities).
 * Status writes are compare-and-set against `activity-machine.ts`.
 *
 * Errors propagate as thrown exceptions; service-layer callers wrap with
 * `ResultAsync.fromPromise` per CLAUDE.md's neverthrow boundary mandate.
 */

import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ACTIVITY_STATUS_WRITTEN_FROM } from '../activity-machine.js';
import { parseStoredJson } from '../json-validation.js';
import type { Activity, ActivityResultRef, ActivityStatus } from '../types.js';
import type { RepoDeps } from './deps.js';
import { updateWithStatusGuard } from './guarded-status-update.js';

export type ActivityRepositoryDeps = RepoDeps;

/** Activities a user keeps before the oldest `succeeded` ones are deleted (design D9). */
export const ACTIVITY_CAP_PER_USER = 500;

export interface ActivityPatch {
  status?: ActivityStatus;
  step?: string | null;
  error?: string | null;
  resultRef?: ActivityResultRef | null;
  endedAt?: string | null;
}

type StoredRow = RepoDeps['schema']['activities']['$inferSelect'];

const inputSchema = z.record(z.string(), z.unknown());
const resultRefSchema = z.object({
  projectId: z.string().optional(),
  prUrl: z.string().optional(),
});

function parseInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const parsed = parseStoredJson(inputSchema, raw, 'activity input');
  return parsed.ok ? parsed.value : {};
}

function parseResultRef(raw: string | null): ActivityResultRef | null {
  if (!raw) return null;
  const parsed = parseStoredJson(resultRefSchema, raw, 'activity result');
  return parsed.ok ? parsed.value : null;
}

function toActivity(row: StoredRow): Activity {
  return {
    id: row.id,
    userId: row.userId,
    runnerId: row.runnerId,
    kind: row.kind,
    projectId: row.projectId,
    threadId: row.threadId,
    title: row.title,
    status: row.status as ActivityStatus,
    step: row.step,
    error: row.error,
    input: parseInput(row.input),
    resultRef: parseResultRef(row.resultRef),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function createActivityRepository(deps: ActivityRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const table = schema.activities;

  async function getById(id: string): Promise<Activity | undefined> {
    const row = await dbGet<StoredRow>(db.select().from(table).where(eq(table.id, id)));
    return row ? toActivity(row) : undefined;
  }

  /** Deletes the user's oldest `succeeded` rows beyond the cap; returns their ids. */
  async function enforceCap(userId: string, cap = ACTIVITY_CAP_PER_USER): Promise<string[]> {
    const counted = await dbGet<{ n: number }>(
      db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.userId, userId)),
    );
    const excess = Number(counted?.n ?? 0) - cap;
    if (excess <= 0) return [];
    const victims = await dbAll<{ id: string }>(
      db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.status, 'succeeded')))
        .orderBy(asc(table.startedAt))
        .limit(excess),
    );
    const ids = victims.map((v) => v.id);
    if (ids.length > 0) await dbRun(db.delete(table).where(inArray(table.id, ids)));
    return ids;
  }

  /**
   * Inserts a `running` activity. Returns false when the id already exists
   * (a retried start is not an error), plus the ids the cap deleted.
   */
  async function insert(
    activity: Omit<Activity, 'status' | 'endedAt' | 'step' | 'error' | 'resultRef'> & {
      step?: string | null;
    },
  ): Promise<{ inserted: boolean; capped: string[] }> {
    const rows = await dbAll<{ id: string }>(
      db
        .insert(table)
        .values({
          id: activity.id,
          userId: activity.userId,
          runnerId: activity.runnerId,
          kind: activity.kind,
          projectId: activity.projectId,
          threadId: activity.threadId,
          title: activity.title,
          status: 'running',
          step: activity.step ?? null,
          input: JSON.stringify(activity.input ?? {}),
          startedAt: activity.startedAt,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: table.id }),
    );
    if (rows.length === 0) return { inserted: false, capped: [] };
    return { inserted: true, capped: await enforceCap(activity.userId) };
  }

  /**
   * Patches an activity. A status in the patch is written only from a status the
   * machine allows; `runnerId` (when given) must still own the row. False means
   * nothing was written.
   */
  function update(id: string, patch: ActivityPatch, runnerId?: string): Promise<boolean> {
    const { resultRef, ...rest } = patch;
    const stored: Omit<ActivityPatch, 'resultRef'> & { resultRef?: string | null } = { ...rest };
    if (resultRef !== undefined) {
      stored.resultRef = resultRef === null ? null : JSON.stringify(resultRef);
    }
    return updateWithStatusGuard(
      deps,
      table,
      id,
      stored,
      ACTIVITY_STATUS_WRITTEN_FROM,
      runnerId === undefined ? [] : [eq(table.runnerId, runnerId)],
    );
  }

  /** The user's activities, newest first. */
  async function listByUser(userId: string): Promise<Activity[]> {
    const rows = await dbAll<StoredRow>(
      db.select().from(table).where(eq(table.userId, userId)).orderBy(desc(table.startedAt)),
    );
    return rows.map(toActivity);
  }

  /** Deletes one of the user's activities; false when it is not theirs or gone. */
  async function remove(id: string, userId: string): Promise<boolean> {
    const rows = await dbAll<{ id: string }>(
      db
        .delete(table)
        .where(and(eq(table.id, id), eq(table.userId, userId)))
        .returning({ id: table.id }),
    );
    return rows.length > 0;
  }

  /** Deletes the user's non-running activities; returns their ids. */
  async function clearFinished(userId: string): Promise<string[]> {
    const rows = await dbAll<{ id: string }>(
      db
        .delete(table)
        .where(and(eq(table.userId, userId), ne(table.status, 'running')))
        .returning({ id: table.id }),
    );
    return rows.map((r) => r.id);
  }

  /** Marks a runner's `running` activities `interrupted`; returns the changed rows. */
  async function interruptRunner(runnerId: string, keepIds: string[] = []): Promise<Activity[]> {
    const now = new Date().toISOString();
    const rows = await dbAll<StoredRow>(
      db
        .update(table)
        .set({ status: 'interrupted', updatedAt: now })
        .where(
          and(
            eq(table.runnerId, runnerId),
            inArray(table.status, [...ACTIVITY_STATUS_WRITTEN_FROM.interrupted]),
            ...(keepIds.length > 0 ? [notInArray(table.id, keepIds)] : []),
          ),
        )
        .returning(),
    );
    return rows.map(toActivity);
  }

  /**
   * Reconciliation on runner connect (design D4): every `running` activity of
   * the runner that it does not list as live becomes `interrupted`.
   */
  function reconcile(runnerId: string, liveIds: string[]): Promise<Activity[]> {
    return interruptRunner(runnerId, liveIds);
  }

  return {
    getById,
    insert,
    update,
    listByUser,
    remove,
    clearFinished,
    reconcile,
    interruptRunner,
    enforceCap,
  };
}

export type ActivityRepository = ReturnType<typeof createActivityRepository>;
