/**
 * @domain subdomain: Watchers
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for agent watchers (deferred-wake "snooze").
 * A watcher is a durable scheduled wake an agent registers via the
 * `funny_watch` tool. The runtime's `watcher-manager` drives the due-time
 * scanner over `nextWakeAt`; this repository is the source of truth.
 *
 * Errors propagate as thrown exceptions; service-layer callers wrap with
 * `Result.fromThrowable` per CLAUDE.md's neverthrow boundary mandate.
 */

import { and, eq, inArray, lte } from 'drizzle-orm';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';
import type { WatcherStatus } from '../types.js';

export interface WatcherRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export interface WatcherRow {
  id: string;
  threadId: string;
  userId: string;
  key: string;
  label: string;
  nextWakeAt: number;
  lastDelayMs: number;
  wakeCount: number;
  maxWakes: number;
  deadline: number | null;
  status: WatcherStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WatcherPatch {
  nextWakeAt?: number;
  lastDelayMs?: number;
  wakeCount?: number;
  status?: WatcherStatus;
  updatedAt?: string;
}

/** Statuses that still participate in scheduling / dedupe lookups. */
const LIVE_STATUSES: WatcherStatus[] = ['pending', 'fired'];

export function createWatcherRepository(deps: WatcherRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const table = schema.watchers;

  async function insert(row: WatcherRow): Promise<WatcherRow> {
    await dbRun(db.insert(table).values(row));
    return row;
  }

  async function getById(id: string): Promise<WatcherRow | undefined> {
    return dbGet<WatcherRow>(db.select().from(table).where(eq(table.id, id)));
  }

  /** The live watcher for a (threadId, key), used by idempotent create-or-reschedule. */
  async function getLiveByThreadKey(
    threadId: string,
    key: string,
  ): Promise<WatcherRow | undefined> {
    return dbGet<WatcherRow>(
      db
        .select()
        .from(table)
        .where(
          and(
            eq(table.threadId, threadId),
            eq(table.key, key),
            inArray(table.status, LIVE_STATUSES),
          ),
        ),
    );
  }

  /** All watchers awaiting a future fire — loaded on boot to re-arm the scanner. */
  async function listPending(): Promise<WatcherRow[]> {
    return dbAll<WatcherRow>(db.select().from(table).where(eq(table.status, 'pending')));
  }

  /** Pending watchers whose `nextWakeAt` deadline has passed (`<= now`). */
  async function listDue(now: number): Promise<WatcherRow[]> {
    return dbAll<WatcherRow>(
      db
        .select()
        .from(table)
        .where(and(eq(table.status, 'pending'), lte(table.nextWakeAt, now))),
    );
  }

  async function listByUser(userId: string): Promise<WatcherRow[]> {
    return dbAll<WatcherRow>(db.select().from(table).where(eq(table.userId, userId)));
  }

  async function update(id: string, patch: WatcherPatch): Promise<void> {
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

  return {
    insert,
    getById,
    getLiveByThreadKey,
    listPending,
    listDue,
    listByUser,
    update,
    deleteByThread,
  };
}

export type WatcherRepository = ReturnType<typeof createWatcherRepository>;
