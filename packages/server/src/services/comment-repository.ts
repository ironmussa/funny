/**
 * Comment CRUD operations.
 * Extracted from thread-manager.ts for single-responsibility.
 */

import { eq, asc, inArray, count as drizzleCount } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, schema } from '../db/index.js';

/** List comments for a thread, ordered by creation time */
export function listComments(threadId: string) {
  return db
    .select()
    .from(schema.threadComments)
    .where(eq(schema.threadComments.threadId, threadId))
    .orderBy(asc(schema.threadComments.createdAt))
    .all();
}

/** Insert a comment, returns the created record */
export function insertComment(data: {
  threadId: string;
  userId: string;
  source: string;
  content: string;
}) {
  const id = nanoid();
  const createdAt = new Date().toISOString();
  db.insert(schema.threadComments)
    .values({
      id,
      threadId: data.threadId,
      userId: data.userId,
      source: data.source,
      content: data.content,
      createdAt,
    })
    .run();
  return { id, ...data, createdAt };
}

/** Delete a comment by ID */
export function deleteComment(commentId: string) {
  db.delete(schema.threadComments).where(eq(schema.threadComments.id, commentId)).run();
}

/** Get comment counts for a list of thread IDs */
export function getCommentCounts(threadIds: string[]): Map<string, number> {
  if (threadIds.length === 0) return new Map();
  const rows = db
    .select({
      threadId: schema.threadComments.threadId,
      count: drizzleCount(),
    })
    .from(schema.threadComments)
    .where(inArray(schema.threadComments.threadId, threadIds))
    .groupBy(schema.threadComments.threadId)
    .all();
  return new Map(rows.map((r) => [r.threadId, r.count]));
}
