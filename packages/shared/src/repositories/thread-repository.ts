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

  /** List threads, optionally filtered by projectId, userId, and archive status */
  async function listThreads(opts: {
    projectId?: string;
    userId: string;
    includeArchived?: boolean;
    organizationId?: string | null;
  }) {
    const { projectId, userId, includeArchived, organizationId } = opts;
    const filters: ReturnType<typeof eq>[] = [];

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
        return [];
      }
    } else {
      filters.push(eq(schema.threads.userId, userId));
    }
    if (projectId) {
      filters.push(eq(schema.threads.projectId, projectId));
    }
    if (!includeArchived) {
      filters.push(eq(schema.threads.archived, 0));
    }

    const condition = filters.length > 0 ? and(...filters) : undefined;
    const completionTime = sql`COALESCE(${schema.threads.completedAt}, ${schema.threads.createdAt})`;
    const threads = await dbAll(
      db
        .select()
        .from(schema.threads)
        .where(condition)
        .orderBy(desc(schema.threads.pinned), desc(completionTime)),
    );

    if (threads.length > 0) {
      const ids = threads.map((t: any) => t.id);
      const counts = await getCommentCounts(ids);
      const snippets = await getLastAssistantSnippets(ids);
      return threads.map((t: any) => ({
        ...t,
        commentCount: counts.get(t.id) ?? 0,
        lastAssistantMessage: snippets.get(t.id),
      }));
    }
    return threads;
  }

  /** List archived threads with pagination and search */
  async function listArchivedThreads(opts: {
    page: number;
    limit: number;
    search: string;
    userId: string;
  }) {
    const { page, limit, search, userId } = opts;
    const offset = (page - 1) * limit;

    const safeSearch = search ? escapeLike(search) : '';
    const filters: ReturnType<typeof eq>[] = [eq(schema.threads.archived, 1)];

    filters.push(eq(schema.threads.userId, userId));

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

  /** Insert a new thread */
  async function createThread(data: typeof schema.threads.$inferInsert) {
    await dbRun(db.insert(schema.threads).values(data));
    const initialStage = data.stage ?? 'backlog';
    await recordStageChange(data.id, null, initialStage);
  }

  /** Update thread fields by ID */
  async function updateThread(
    id: string,
    updates: Partial<{
      status: string;
      sessionId: string | null;
      cost: number;
      completedAt: string | null;
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
    }>,
  ) {
    if (updates.stage !== undefined) {
      const currentThread = await dbGet<{ stage: string }>(
        db
          .select({ stage: schema.threads.stage })
          .from(schema.threads)
          .where(eq(schema.threads.id, id)),
      );

      if (currentThread && currentThread.stage !== updates.stage) {
        await recordStageChange(id, currentThread.stage, updates.stage);
      }
    }

    if (updates.archived !== undefined) {
      const currentThread = await dbGet<{ stage: string; archived: number }>(
        db
          .select({ stage: schema.threads.stage, archived: schema.threads.archived })
          .from(schema.threads)
          .where(eq(schema.threads.id, id)),
      );

      if (currentThread) {
        if (updates.archived === 1 && currentThread.archived === 0) {
          await recordStageChange(id, currentThread.stage, 'archived');
        } else if (updates.archived === 0 && currentThread.archived === 1) {
          await recordStageChange(id, 'archived', updates.stage ?? currentThread.stage);
        }
      }
    }

    await dbRun(db.update(schema.threads).set(updates).where(eq(schema.threads.id, id)));
  }

  /** Delete a thread (cascade deletes messages + tool_calls) */
  async function deleteThread(id: string) {
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

  return {
    listThreads,
    listArchivedThreads,
    getThread,
    getThreadByExternalRequestId,
    createThread,
    updateThread,
    deleteThread,
    markStaleThreadsInterrupted,
    markStaleExternalThreadsStopped,
  };
}
