/* eslint-disable max-lines, max-lines-per-function */
/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database, StageHistory, CommentRepository
 *
 * DB-agnostic thread repository. Accepts db + schema via dependency injection.
 */

import { eq, and, or, ne, like, desc, inArray, count as drizzleCount, sql } from 'drizzle-orm';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';
import type { createCommentRepository } from './comment-repository.js';
import { createGrantRepository } from './grant-repository.js';
import type { createStageHistoryRepository } from './stage-history.js';

/** Max characters for the last-message snippet returned with thread lists */
const SNIPPET_MAX_LENGTH = 120;

/** Escape SQL LIKE wildcards so user input is treated as literal text */
function escapeLike(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface ThreadRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
  /** Optional logger for info messages */
  log?: { info: (msg: string, meta?: any) => void };
  /** Comment repository instance (for getCommentCounts) */
  commentRepo: ReturnType<typeof createCommentRepository>;
  /** Stage history repository instance (for recordStageChange) */
  stageHistoryRepo: ReturnType<typeof createStageHistoryRepository>;
}

export function createThreadRepository(deps: ThreadRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun, log, commentRepo, stageHistoryRepo } = deps;
  const { getCommentCounts } = commentRepo;
  const { recordStageChange } = stageHistoryRepo;

  /**
   * Fetch the last non-empty assistant message snippet for a batch of thread IDs.
   * Uses Drizzle with MAX(timestamp) subquery -- works on both SQLite and PostgreSQL.
   */
  async function getLastAssistantSnippets(threadIds: string[]): Promise<Map<string, string>> {
    if (threadIds.length === 0) return new Map();

    // Single JOIN query — avoids large OR expression trees that hit SQLite's depth limit (1000)
    const latestSq = db
      .select({
        threadId: schema.messages.threadId,
        maxTs: sql<string>`MAX(${schema.messages.timestamp})`.as('max_ts'),
      })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.threadId, threadIds),
          eq(schema.messages.role, 'assistant'),
          ne(schema.messages.content, ''),
        ),
      )
      .groupBy(schema.messages.threadId)
      .as('latest');

    const rows = await dbAll<{ threadId: string; content: string }>(
      db
        .select({
          threadId: schema.messages.threadId,
          content: schema.messages.content,
        })
        .from(schema.messages)
        .innerJoin(
          latestSq,
          and(
            eq(schema.messages.threadId, latestSq.threadId),
            eq(schema.messages.timestamp, latestSq.maxTs),
          ),
        ) as any,
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      if (!map.has(row.threadId)) {
        map.set(row.threadId, row.content.slice(0, SNIPPET_MAX_LENGTH));
      }
    }
    return map;
  }

  /** List threads, optionally filtered by projectId, userId, and archive status.
   *  Supports server-side pagination via limit/offset.
   *  `isScratch`:
   *    - `true`    → only scratch threads (`is_scratch = 1`)
   *    - `'exclude'` → only non-scratch (`is_scratch = 0`)
   *    - undefined → no filter
   */
  async function listThreads(opts: {
    projectId?: string;
    userId: string;
    includeArchived?: boolean;
    organizationId?: string | null;
    designId?: string;
    isScratch?: boolean | 'exclude';
    limit?: number;
    offset?: number;
  }): Promise<{ threads: any[]; total: number }> {
    const { projectId, userId, includeArchived, organizationId, designId, isScratch } = opts;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const filters: ReturnType<typeof eq>[] = [];

    if (isScratch === true) {
      filters.push(eq(schema.threads.isScratch, 1));
    } else if (isScratch === 'exclude') {
      filters.push(eq(schema.threads.isScratch, 0));
    }

    if (organizationId) {
      // Org mode: only show threads for projects associated with this organization
      const orgProjectIds = (
        await dbAll(
          db
            .select({ projectId: schema.teamProjects.projectId })
            .from(schema.teamProjects)
            .where(eq(schema.teamProjects.teamId, organizationId)),
        )
      ).map((r: any) => r.projectId);

      if (orgProjectIds.length > 0) {
        filters.push(inArray(schema.threads.projectId, orgProjectIds));
      } else {
        // No projects in this org -- return empty
        return { threads: [], total: 0 };
      }
    } else {
      filters.push(eq(schema.threads.userId, userId));
    }
    if (projectId) {
      filters.push(eq(schema.threads.projectId, projectId));
    }
    if (designId) {
      filters.push(eq(schema.threads.designId, designId));
    }
    if (!includeArchived) {
      filters.push(eq(schema.threads.archived, 0));
    }

    const condition = filters.length > 0 ? and(...filters) : undefined;

    // Count total matching threads (cheap indexed query)
    const [{ total }] = await dbAll(
      db.select({ total: drizzleCount() }).from(schema.threads).where(condition),
    );

    const activityTime = sql`COALESCE(${schema.threads.completedAt}, ${schema.threads.createdAt})`;
    const threads = await dbAll(
      db
        .select()
        .from(schema.threads)
        .where(condition)
        .orderBy(desc(schema.threads.pinned), desc(activityTime))
        .limit(limit)
        .offset(offset),
    );

    if (threads.length > 0) {
      const ids = threads.map((t: any) => t.id);
      const counts = await getCommentCounts(ids);
      const snippets = await getLastAssistantSnippets(ids);
      return {
        threads: threads.map((t: any) => ({
          ...t,
          commentCount: counts.get(t.id) ?? 0,
          lastAssistantMessage: snippets.get(t.id),
        })),
        total: Number(total),
      };
    }
    return { threads, total: Number(total) };
  }

  /** List archived threads with pagination and search */
  async function listArchivedThreads(opts: {
    page: number;
    limit: number;
    search: string;
    userId: string;
    projectId?: string;
  }) {
    const { page, limit, search, userId, projectId } = opts;
    const offset = (page - 1) * limit;

    const safeSearch = search ? escapeLike(search) : '';
    const filters: ReturnType<typeof eq>[] = [eq(schema.threads.archived, 1)];

    filters.push(eq(schema.threads.userId, userId));

    // Archived threads are scoped per-project in the project settings view.
    if (projectId) {
      filters.push(eq(schema.threads.projectId, projectId));
    }

    if (search) {
      filters.push(
        or(
          like(schema.threads.title, `%${safeSearch}%`),
          like(schema.threads.branch, `%${safeSearch}%`),
          like(schema.threads.status, `%${safeSearch}%`),
        ) as any,
      );
    }

    const conditions = and(...filters);

    const [{ total }] = await dbAll(
      db.select({ total: drizzleCount() }).from(schema.threads).where(conditions!),
    );

    const completionTime = sql`COALESCE(${schema.threads.completedAt}, ${schema.threads.createdAt})`;
    const threads = await dbAll(
      db
        .select()
        .from(schema.threads)
        .where(conditions!)
        .orderBy(desc(completionTime))
        .limit(limit)
        .offset(offset),
    );

    return { threads, total };
  }

  /** Get a single thread by ID */
  async function getThread(id: string) {
    return dbGet(db.select().from(schema.threads).where(eq(schema.threads.id, id)));
  }

  /** Get a thread by its external request ID (used by ingest mapper) */
  async function getThreadByExternalRequestId(requestId: string) {
    return dbGet(
      db.select().from(schema.threads).where(eq(schema.threads.externalRequestId, requestId)),
    );
  }

  /** Get a thread by its sessionId (used by ingest mapper) */
  async function getThreadBySessionId(sessionId: string) {
    return dbGet(db.select().from(schema.threads).where(eq(schema.threads.sessionId, sessionId)));
  }

  /** Insert a new thread (atomic: thread insert + initial stage history) */
  async function createThread(data: typeof schema.threads.$inferInsert) {
    await db.transaction(async (tx) => {
      await dbRun(tx.insert(schema.threads).values(data));
      const initialStage = data.stage ?? 'backlog';
      await recordStageChange(data.id, null, initialStage, tx);
    });
  }

  /** Update thread fields by ID. Automatically bumps updatedAt.
   *  Wraps read-then-write + stage history in a transaction to prevent race conditions. */
  async function updateThread(
    id: string,
    updates: Partial<{
      status: string;
      sessionId: string | null;
      cost: number;
      completedAt: string | null;
      updatedAt: string;
      archived: number;
      pinned: number;
      stage: string;
      branch: string | null;
      baseBranch: string | null;
      worktreePath: string | null;
      mode: string;
      permissionMode: string;
      model: string;
      provider: string;
      initTools: string;
      initCwd: string;
      initSlashCommands: string;
      contextRecoveryReason: string | null;
    }>,
  ) {
    const needsStageCheck = updates.stage !== undefined || updates.archived !== undefined;

    if (!needsStageCheck) {
      // Simple update — no stage history needed, skip transaction overhead
      const withTimestamp = { ...updates, updatedAt: new Date().toISOString() };
      await dbRun(db.update(schema.threads).set(withTimestamp).where(eq(schema.threads.id, id)));
      return;
    }

    // Wrap read + stage history + update in a transaction to prevent races
    await db.transaction(async (tx) => {
      if (updates.stage !== undefined) {
        const currentThread = await dbGet<{ stage: string }>(
          tx
            .select({ stage: schema.threads.stage })
            .from(schema.threads)
            .where(eq(schema.threads.id, id)),
        );

        if (currentThread && currentThread.stage !== updates.stage) {
          await recordStageChange(id, currentThread.stage, updates.stage, tx as any);
        }
      }

      if (updates.archived !== undefined) {
        const currentThread = await dbGet<{ stage: string; archived: number }>(
          tx
            .select({ stage: schema.threads.stage, archived: schema.threads.archived })
            .from(schema.threads)
            .where(eq(schema.threads.id, id)),
        );

        if (currentThread) {
          if (updates.archived === 1 && currentThread.archived === 0) {
            await recordStageChange(id, currentThread.stage, 'archived', tx as any);
          } else if (updates.archived === 0 && currentThread.archived === 1) {
            await recordStageChange(
              id,
              'archived',
              updates.stage ?? currentThread.stage,
              tx as any,
            );
          }
        }
      }

      // Always bump updatedAt on every thread update
      const withTimestamp = { ...updates, updatedAt: new Date().toISOString() };
      await dbRun(tx.update(schema.threads).set(withTimestamp).where(eq(schema.threads.id, id)));
    });
  }

  /** Delete a thread (cascade deletes messages + tool_calls) */
  async function deleteThread(id: string) {
    // Purge unified grants first — resource_grants is polymorphic and does NOT
    // cascade on thread delete (unified-rbac-grants).
    await createGrantRepository({ db, schema, dbAll, dbRun }).deleteGrantsForResource('thread', id);
    await dbRun(db.delete(schema.threads).where(eq(schema.threads.id, id)));
  }

  /** Mark stale (running/waiting) threads as interrupted. Called on server startup. */
  async function markStaleThreadsInterrupted(): Promise<void> {
    const staleCondition = and(
      or(eq(schema.threads.status, 'running'), eq(schema.threads.status, 'waiting')),
      ne(schema.threads.provider, 'external'),
    );

    const stale = await dbAll(
      db.select({ id: schema.threads.id }).from(schema.threads).where(staleCondition),
    );

    if (stale.length > 0) {
      await dbRun(
        db
          .update(schema.threads)
          .set({ status: 'interrupted', completedAt: new Date().toISOString() })
          .where(staleCondition),
      );
      log?.info(`Marked ${stale.length} stale thread(s) as interrupted`, {
        namespace: 'thread-manager',
        count: stale.length,
      });
    }
  }

  /** Mark stale external threads (running/pending) as stopped. Called on server startup. */
  async function markStaleExternalThreadsStopped(): Promise<void> {
    const staleCondition = and(
      or(
        eq(schema.threads.status, 'running'),
        eq(schema.threads.status, 'pending'),
        eq(schema.threads.status, 'waiting'),
      ),
      eq(schema.threads.provider, 'external'),
    );

    const stale = await dbAll(
      db.select({ id: schema.threads.id }).from(schema.threads).where(staleCondition),
    );

    if (stale.length > 0) {
      await dbRun(
        db
          .update(schema.threads)
          .set({ status: 'stopped', completedAt: new Date().toISOString() })
          .where(staleCondition),
      );
      log?.info(`Marked ${stale.length} stale external thread(s) as stopped`, {
        namespace: 'thread-manager',
        count: stale.length,
      });
    }
  }

  /**
   * Mark stale running threads for a specific runner as interrupted and return them.
   * Called by the runner on startup so it can auto-resume interrupted work.
   * Only targets threads that were actively `running` (not `waiting` — those need user input).
   */
  async function markAndListStaleThreads(runnerId: string): Promise<any[]> {
    const staleCondition = and(
      eq(schema.threads.status, 'running'),
      eq(schema.threads.runnerId, runnerId),
      ne(schema.threads.provider, 'external'),
    );

    const stale = await dbAll(db.select().from(schema.threads).where(staleCondition));

    if (stale.length > 0) {
      await dbRun(
        db
          .update(schema.threads)
          .set({ status: 'interrupted', completedAt: new Date().toISOString() })
          .where(staleCondition),
      );
      log?.info(`Marked ${stale.length} stale thread(s) as interrupted for runner auto-resume`, {
        namespace: 'thread-manager',
        runnerId,
        count: stale.length,
        threadIds: stale.map((t) => t.id),
      });
    }

    return stale;
  }

  return {
    listThreads,
    listArchivedThreads,
    getThread,
    getThreadByExternalRequestId,
    getThreadBySessionId,
    createThread,
    updateThread,
    deleteThread,
    markStaleThreadsInterrupted,
    markStaleExternalThreadsStopped,
    markAndListStaleThreads,
  };
}
