/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic thread-share repository. Accepts db + schema via dependency
 * injection. Backs the `thread-sharing` feature: per-thread, identity-gated
 * read+comment grants. A share is keyed on (threadId, sharedWithUserId) — the
 * grant row IS the credential; there is no token.
 */

import { and, asc, eq } from 'drizzle-orm';

import type { AppDatabase, dbAll as dbAllFn, dbRun as dbRunFn } from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

/**
 * Share permission level. `view` is read + comment + presence (the original
 * thread-sharing scope); `steer` adds git read-only + follow-ups. See change
 * `thread-sharing-steer`.
 */
export type ShareLevel = 'view' | 'steer';

export interface ThreadShareRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbRun: typeof dbRunFn;
}

export function createThreadShareRepository(deps: ThreadShareRepositoryDeps) {
  const { db, schema, dbAll, dbRun } = deps;

  /** True when `userId` holds an active share grant for `threadId`. */
  async function hasShare(threadId: string, userId: string): Promise<boolean> {
    const rows = await dbAll(
      db
        .select()
        .from(schema.threadShares)
        .where(
          and(
            eq(schema.threadShares.threadId, threadId),
            eq(schema.threadShares.sharedWithUserId, userId),
          ),
        ),
    );
    return rows.length > 0;
  }

  /**
   * The share level `userId` holds on `threadId`, or `null` when there is no
   * grant. A grant row missing an explicit level (created before the
   * `thread-sharing-steer` migration) reads as `view`.
   */
  async function getShareLevel(threadId: string, userId: string): Promise<ShareLevel | null> {
    const rows = await dbAll(
      db
        .select({ level: schema.threadShares.level })
        .from(schema.threadShares)
        .where(
          and(
            eq(schema.threadShares.threadId, threadId),
            eq(schema.threadShares.sharedWithUserId, userId),
          ),
        ),
    );
    if (rows.length === 0) return null;
    return (rows[0] as { level?: string }).level === 'steer' ? 'steer' : 'view';
  }

  /**
   * Grant `sharedWithUserId` access to `threadId` at the given `level`
   * (default `view`). Idempotent: a repeat share with the same pair returns the
   * existing grant rather than violating the composite primary key.
   */
  async function createShare(data: {
    threadId: string;
    sharedWithUserId: string;
    sharedByUserId: string;
    level?: ShareLevel;
  }) {
    const createdAt = new Date().toISOString();
    const level: ShareLevel = data.level ?? 'view';
    if (await hasShare(data.threadId, data.sharedWithUserId)) {
      return { ...data, level, createdAt, alreadyExisted: true as const };
    }
    await dbRun(
      db.insert(schema.threadShares).values({
        threadId: data.threadId,
        sharedWithUserId: data.sharedWithUserId,
        sharedByUserId: data.sharedByUserId,
        level,
        createdAt,
      }),
    );
    return { ...data, level, createdAt, alreadyExisted: false as const };
  }

  /** All grants on a thread, oldest first (for the owner's "shared with" list). */
  async function listSharesForThread(threadId: string) {
    return dbAll(
      db
        .select()
        .from(schema.threadShares)
        .where(eq(schema.threadShares.threadId, threadId))
        .orderBy(asc(schema.threadShares.createdAt)),
    );
  }

  /**
   * The thread rows shared TO `userId` — backs the "Shared with me" feed.
   * Joins thread_shares → threads so callers get full thread data directly.
   */
  async function listThreadsSharedWithUser(userId: string) {
    const rows = await dbAll(
      db
        .select()
        .from(schema.threadShares)
        .innerJoin(schema.threads, eq(schema.threadShares.threadId, schema.threads.id))
        .where(eq(schema.threadShares.sharedWithUserId, userId)),
    );
    return rows.map((r: any) => r.threads);
  }

  /** Revoke a grant. No-op if it does not exist. */
  async function deleteShare(threadId: string, sharedWithUserId: string) {
    await dbRun(
      db
        .delete(schema.threadShares)
        .where(
          and(
            eq(schema.threadShares.threadId, threadId),
            eq(schema.threadShares.sharedWithUserId, sharedWithUserId),
          ),
        ),
    );
  }

  return {
    hasShare,
    getShareLevel,
    createShare,
    listSharesForThread,
    listThreadsSharedWithUser,
    deleteShare,
  };
}
