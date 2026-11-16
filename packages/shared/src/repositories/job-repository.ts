/**
 * @domain subdomain: Jobs
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for agent jobs (funny-owned detached background
 * processes launched via funny_spawn). The runtime's `agent-job-manager`
 * derives status from the exitfile + pid liveness; this repository is the
 * durable record.
 *
 * Errors propagate as thrown exceptions; service-layer callers wrap with
 * `Result.fromThrowable` per CLAUDE.md's neverthrow boundary mandate.
 */

import { and, eq, inArray } from 'drizzle-orm';

import { JOB_STATUS_WRITTEN_FROM } from '../job-machine.js';
import type { Job, JobStatus } from '../types.js';
import type { RepoDeps } from './deps.js';

export type JobRepositoryDeps = RepoDeps;

/** A row is the shared `Job` type: the columns map one to one. */
export type JobRow = Job;

export interface JobPatch {
  pid?: number | null;
  status?: JobStatus;
  exitCode?: number | null;
  updatedAt?: string;
}

export function createJobRepository(deps: JobRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const table = schema.jobs;

  async function insert(row: JobRow): Promise<JobRow> {
    await dbRun(db.insert(table).values(row));
    return row;
  }

  async function getById(id: string): Promise<JobRow | undefined> {
    return dbGet<JobRow>(db.select().from(table).where(eq(table.id, id)));
  }

  /**
   * Running jobs, optionally scoped to one runner's user (isolation boundary).
   * Used by the scanner to poll for completion.
   */
  async function listRunning(userId?: string): Promise<JobRow[]> {
    const cond = userId
      ? and(eq(table.status, 'running'), eq(table.userId, userId))
      : eq(table.status, 'running');
    return dbAll<JobRow>(db.select().from(table).where(cond));
  }

  async function listByUser(userId: string): Promise<JobRow[]> {
    return dbAll<JobRow>(db.select().from(table).where(eq(table.userId, userId)));
  }

  /**
   * Patch a job. A patch that carries a `status` is a transition: it is
   * applied only from a status the job machine allows (compare-and-set).
   * Returns false when nothing was written — no such row, or the row is no
   * longer in a status the transition is legal from.
   */
  async function update(id: string, patch: JobPatch): Promise<boolean> {
    // An unknown status has no legal source: `inArray(…, [])` matches no row.
    const from = patch.status === undefined ? null : (JOB_STATUS_WRITTEN_FROM[patch.status] ?? []);
    const rows = await dbAll<{ id: string }>(
      db
        .update(table)
        .set({ updatedAt: new Date().toISOString(), ...patch })
        .where(from ? and(eq(table.id, id), inArray(table.status, [...from])) : eq(table.id, id))
        .returning({ id: table.id }),
    );
    return rows.length > 0;
  }

  async function deleteByThread(threadId: string): Promise<void> {
    await dbRun(db.delete(table).where(eq(table.threadId, threadId)));
  }

  return { insert, getById, listRunning, listByUser, update, deleteByThread };
}

export type JobRepository = ReturnType<typeof createJobRepository>;
