/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic comment repository. Accepts db + schema via dependency injection.
 */

import { and, eq, desc, inArray, count as drizzleCount } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { RepoDeps } from './deps.js';

export type CommentRepositoryDeps = Pick<RepoDeps, 'db' | 'schema' | 'dbAll' | 'dbRun'>;

export function createCommentRepository(deps: CommentRepositoryDeps) {
  const { db, schema, dbAll, dbRun } = deps;

  /**
   * One page of a thread's comments, oldest first. Pages count back from the
   * newest comment: `offset` 0 is the latest `limit` comments, so a long
   * discussion never loads whole. Ties on `createdAt` are broken by id so
   * consecutive pages neither repeat nor skip a row.
   */
  async function listComments(threadId: string, page: { limit: number; offset?: number }) {
    const rows = await dbAll(
      db
        .select()
        .from(schema.threadComments)
        .where(eq(schema.threadComments.threadId, threadId))
        .orderBy(desc(schema.threadComments.createdAt), desc(schema.threadComments.id))
        .limit(page.limit)
        .offset(page.offset ?? 0),
    );
    return rows.reverse();
  }

  /** Insert a comment, returns the created record */
  async function insertComment(data: {
    threadId: string;
    userId: string;
    source: string;
    content: string;
  }) {
    const id = nanoid();
    const createdAt = new Date().toISOString();
    await dbRun(
      db.insert(schema.threadComments).values({
        id,
        threadId: data.threadId,
        userId: data.userId,
        source: data.source,
        content: data.content,
        createdAt,
      }),
    );
    return { id, ...data, createdAt };
  }

  /**
   * Delete a comment, scoped to the thread it belongs to. A comment id from a
   * DIFFERENT thread never matches, so an owner of thread A cannot delete
   * comments on thread B by pairing A's id with B's comment id.
   * Returns `true` when a comment was deleted, `false` when none matched.
   */
  async function deleteComment(threadId: string, commentId: string): Promise<boolean> {
    const scope = and(
      eq(schema.threadComments.id, commentId),
      eq(schema.threadComments.threadId, threadId),
    );
    const existing = await dbAll(
      db.select({ id: schema.threadComments.id }).from(schema.threadComments).where(scope),
    );
    if (existing.length === 0) return false;
    await dbRun(db.delete(schema.threadComments).where(scope));
    return true;
  }

  /** Get comment counts for a list of thread IDs */
  async function getCommentCounts(threadIds: string[]): Promise<Map<string, number>> {
    if (threadIds.length === 0) return new Map();
    const rows = await dbAll(
      db
        .select({
          threadId: schema.threadComments.threadId,
          count: drizzleCount(),
        })
        .from(schema.threadComments)
        .where(inArray(schema.threadComments.threadId, threadIds))
        .groupBy(schema.threadComments.threadId),
    );
    return new Map(rows.map((r: any) => [r.threadId, r.count]));
  }

  return {
    listComments,
    insertComment,
    deleteComment,
    getCommentCounts,
  };
}
