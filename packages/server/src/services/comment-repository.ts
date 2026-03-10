/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { eq, asc, inArray, count as drizzleCount } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbRun, schema } from '../db/index.js';

/** List comments for a thread, ordered by creation time */
export async function listComments(threadId: string) {
  return dbAll(
    db
      .select()
      .from(schema.threadComments)
      .where(eq(schema.threadComments.threadId, threadId))
      .orderBy(asc(schema.threadComments.createdAt)),
  );
}

/** Insert a comment, returns the created record */
export async function insertComment(data: {
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

/** Delete a comment by ID */
export async function deleteComment(commentId: string) {
  await dbRun(db.delete(schema.threadComments).where(eq(schema.threadComments.id, commentId)));
}

/** Get comment counts for a list of thread IDs */
export async function getCommentCounts(threadIds: string[]): Promise<Map<string, number>> {
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
