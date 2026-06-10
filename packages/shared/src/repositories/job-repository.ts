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

import { and, eq } from 'drizzle-orm';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';
import type { JobStatus } from '../types.js';

export interface JobRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export interface JobRow {
  id: string;
  threadId: string;
  userId: string;
  command: string;
  cwd: string | null;
  label: string | null;
  pid: number | null;
  logPath: string;
  exitPath: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
}

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

  async function update(id: string, patch: JobPatch): Promise<void> {
    await dbRun(
      db
        .update(table)
        .set({ updatedAt: new Date().toISOString(), ...patch })
        .where(eq(table.id, id)),
    );
  }

  async function deleteByThread(threadId: string): Promise<void> {
    await dbRun(db.delete(table).where(eq(table.threadId, threadId)));
  }

  return { insert, getById, listRunning, listByUser, update, deleteByThread };
}

export type JobRepository = ReturnType<typeof createJobRepository>;
