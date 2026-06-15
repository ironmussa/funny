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

import { threadLevelToRole } from '../auth/roles.js';
import type { AppDatabase, dbAll as dbAllFn, dbRun as dbRunFn } from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';
import { createGrantRepository } from './grant-repository.js';

/**
 * Share permission level (unified-rbac-grants): `view` (read only), `comment`
 * (read + comment), `steer` (read + comment + follow-ups / edit). Maps to the
 * canonical lattice viewer / commenter / contributor.
 */
export type ShareLevel = 'view' | 'comment' | 'steer';

export interface ThreadShareRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbRun: typeof dbRunFn;
}

/**
 * Backs the `thread-sharing` feature. As of unified-rbac-grants (Phase 4) this
 * is a dual-read / dual-write seam over the new `resource_grants` table:
 *
 * - Writes go to BOTH `thread_shares` (legacy, still authoritative) AND
 *   `resource_grants` (thread rows), so new grants populate the unified table
 *   immediately and the eventual backfill only has to cover pre-existing rows.
 * - Reads (`hasShare`, `getShareLevel`, the list queries) stay on `thread_shares`
 *   for now — the classic expand phase. Reads switch to `resource_grants` only
 *   at cutover (Phase 8), AFTER explicit grant-cleanup-on-resource-delete lands
 *   (Phase 6): `resource_grants.resource_id` is polymorphic and cannot FK to
 *   `threads`, so it does NOT cascade when a thread is deleted. Reading it before
 *   that cleanup exists would surface orphaned grants. Dual-write keeps the two
 *   in lockstep, so behavior is identical to today.
 *
 * The canonical role↔level mapping is `threadLevelToRole`/`roleToThreadLevel`:
 * `view`↔`viewer`, `steer`↔`contributor`.
 */
export function createThreadShareRepository(deps: ThreadShareRepositoryDeps) {
  const { db, schema, dbAll, dbRun } = deps;
  const grants = createGrantRepository({ db, schema, dbAll, dbRun });

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
    const level = (rows[0] as { level?: string }).level;
    return level === 'steer' ? 'steer' : level === 'comment' ? 'comment' : 'view';
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
    // Dual-write the unified grant (thread row) so new shares populate
    // resource_grants immediately. role ← level via the canonical mapping.
    await grants.upsertGrant({
      subjectId: data.sharedWithUserId,
      resourceType: 'thread',
      resourceId: data.threadId,
      role: threadLevelToRole(level),
      grantedBy: data.sharedByUserId,
    });
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

  /** Revoke a grant from BOTH tables. No-op if it does not exist. */
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
    await grants.deleteGrant(sharedWithUserId, 'thread', threadId);
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
