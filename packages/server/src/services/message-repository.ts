/**
 * Message CRUD operations + thread-with-messages queries.
 * Extracted from thread-manager.ts for single-responsibility.
 */

import { eq, and, lt, asc, desc, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

/** Enrich raw message rows with parsed images and their tool calls */
function enrichMessages(messages: (typeof schema.messages.$inferSelect)[], allToolCalls?: (typeof schema.toolCalls.$inferSelect)[]) {
  const messageIds = messages.map((m) => m.id);
  const toolCalls = allToolCalls ?? (messageIds.length > 0
    ? db.select().from(schema.toolCalls).where(
        messageIds.length === 1
          ? eq(schema.toolCalls.messageId, messageIds[0])
          : inArray(schema.toolCalls.messageId, messageIds)
      ).all()
    : []);

  return messages.map((msg) => ({
    ...msg,
    images: msg.images ? JSON.parse(msg.images) : undefined,
    toolCalls: toolCalls.filter((tc) => tc.messageId === msg.id),
  }));
}

/** Get a thread with its messages and tool calls.
 *  When messageLimit is provided, returns only the N most recent messages
 *  plus a hasMore flag. */
export function getThreadWithMessages(id: string, messageLimit?: number) {
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!thread) return null;

  let messages;
  let hasMore = false;

  if (messageLimit) {
    const rows = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, id))
      .orderBy(desc(schema.messages.timestamp))
      .limit(messageLimit + 1)
      .all();

    hasMore = rows.length > messageLimit;
    messages = (hasMore ? rows.slice(0, messageLimit) : rows).reverse();
  } else {
    messages = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, id))
      .orderBy(asc(schema.messages.timestamp))
      .all();
  }

  return {
    ...thread,
    messages: enrichMessages(messages),
    hasMore,
    initInfo: thread.initTools ? {
      tools: JSON.parse(thread.initTools) as string[],
      cwd: thread.initCwd ?? '',
      model: thread.model ?? '',
    } : undefined,
  };
}

/** Get paginated messages for a thread, older than cursor.
 *  Returns messages in ASC order (oldest first). */
export function getThreadMessages(opts: {
  threadId: string;
  cursor?: string;
  limit: number;
}): { messages: ReturnType<typeof enrichMessages>; hasMore: boolean } {
  const { threadId, cursor, limit } = opts;

  const rows = db
    .select()
    .from(schema.messages)
    .where(
      cursor
        ? and(eq(schema.messages.threadId, threadId), lt(schema.messages.timestamp, cursor))
        : eq(schema.messages.threadId, threadId)
    )
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const sliced = (hasMore ? rows.slice(0, limit) : rows).reverse();

  return { messages: enrichMessages(sliced), hasMore };
}

/** Insert a new message, returns the generated ID */
export function insertMessage(data: {
  threadId: string;
  role: string;
  content: string;
  images?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  author?: string | null;
}): string {
  const id = nanoid();
  db.insert(schema.messages)
    .values({
      id,
      threadId: data.threadId,
      role: data.role,
      content: data.content,
      images: data.images ?? null,
      model: data.model ?? null,
      permissionMode: data.permissionMode ?? null,
      author: data.author ?? null,
      timestamp: new Date().toISOString(),
    })
    .run();
  return id;
}

/** Update message content */
export function updateMessage(id: string, content: string) {
  db.update(schema.messages)
    .set({ content, timestamp: new Date().toISOString() })
    .where(eq(schema.messages.id, id))
    .run();
}
