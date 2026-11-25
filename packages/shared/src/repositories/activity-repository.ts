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

import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { isActivityOrigin, parseActivityEffects } from '../activities/kinds.js';
import { ACTIVITY_STATUS_WRITTEN_FROM } from '../activity-machine.js';
import { parseStoredJson } from '../json-validation.js';
import type { Activity, ActivityEffect, ActivityResultRef, ActivityStatus } from '../types.js';
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
  /** Replaces the stored list (the reporter sends the whole list each time). */
  effects?: ActivityEffect[] | null;
}

/** A new row: `running` by default, or already finished in one write (design D6). */
export type ActivityInsert = Omit<
  Activity,
  'status' | 'endedAt' | 'step' | 'error' | 'resultRef' | 'origin' | 'effects'
> & {
  step?: string | null;
  origin?: Activity['origin'];
  effects?: ActivityEffect[] | null;
  /** A final status records an instant action; its `endedAt` is `startedAt`. */
  status?: 'running' | 'succeeded' | 'failed';
  error?: string | null;
  resultRef?: ActivityResultRef | null;
};

type StoredRow = RepoDeps['schema']['activities']['$inferSelect'];

const inputSchema = z.record(z.string(), z.unknown());
const resultRefSchema = z.object({
  projectId: z.string().optional(),
  prUrl: z.string().optional(),
  snapshot: z.string().optional(),
});

function parseInput(raw: string | null): Activity['input'] {
  if (!raw) return {};
  const parsed = parseStoredJson(inputSchema, raw, 'activity input');
  return parsed.ok ? parsed.value : {};
}

function parseResultRef(raw: string | null): ActivityResultRef | null {
  if (!raw) return null;
  const parsed = parseStoredJson(resultRefSchema, raw, 'activity result');
  return parsed.ok ? parsed.value : null;
}

const effectsSchema = z.array(z.unknown());

function parseEffects(raw: string | null): ActivityEffect[] | null {
  if (!raw) return null;
  const parsed = parseStoredJson(effectsSchema, raw, 'activity effects');
  return parsed.ok ? parseActivityEffects({ effects: parsed.value }) : null;
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
    origin: isActivityOrigin(row.origin) ? row.origin : 'user',
    effects: parseEffects(row.effects),
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
   * Inserts an activity, `running` unless the caller gives a final status (an
   * instant action, written once). Returns false when the id already exists (a
   * retried start is not an error), plus the ids the cap deleted.
   */
  async function insert(
    activity: ActivityInsert,
  ): Promise<{ inserted: boolean; capped: string[] }> {
    const status = activity.status ?? 'running';
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
          status,
          step: activity.step ?? null,
          error: activity.error ?? null,
          input: JSON.stringify(activity.input ?? {}),
          resultRef: activity.resultRef ? JSON.stringify(activity.resultRef) : null,
          origin: activity.origin ?? 'user',
          effects: activity.effects ? JSON.stringify(activity.effects) : null,
          startedAt: activity.startedAt,
          endedAt: status === 'running' ? null : activity.startedAt,
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
   * machine allows; a patch without one only touches a row still in progress.
   * `runnerId` (when given) must still own the row: a string compares
   * `runner_id`, `null` requires a server row (`runner_id IS NULL`), so a runner
   * never writes a server row and the server never writes a runner's. False
   * means nothing was written.
   */
  function update(id: string, patch: ActivityPatch, runnerId?: string | null): Promise<boolean> {
    const { resultRef, effects, ...rest } = patch;
    const stored: Omit<ActivityPatch, 'resultRef' | 'effects'> & {
      resultRef?: string | null;
      effects?: string | null;
    } = { ...rest };
    if (resultRef !== undefined) {
      stored.resultRef = resultRef === null ? null : JSON.stringify(resultRef);
    }
    if (effects !== undefined) {
      stored.effects = effects === null ? null : JSON.stringify(effects);
    }
    const also: SQL[] = [];
    if (runnerId === null) also.push(isNull(table.runnerId));
    else if (runnerId !== undefined) also.push(eq(table.runnerId, runnerId));
    if (patch.status === undefined) also.push(inArray(table.status, ['running', 'interrupted']));
    return updateWithStatusGuard(deps, table, id, stored, ACTIVITY_STATUS_WRITTEN_FROM, also);
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
   * Server start (track-funny-actions, design D7): every `running` server row
   * (no runner) was cut short by the restart and becomes `interrupted`.
   */
  async function interruptServerActivities(): Promise<Activity[]> {
    const rows = await dbAll<StoredRow>(
      db
        .update(table)
        .set({ status: 'interrupted', updatedAt: new Date().toISOString() })
        .where(
          and(
            isNull(table.runnerId),
            inArray(table.status, [...ACTIVITY_STATUS_WRITTEN_FROM.interrupted]),
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
    interruptServerActivities,
    enforceCap,
  };
}

export type ActivityRepository = ReturnType<typeof createActivityRepository>;
