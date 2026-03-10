/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 */

import { eq, and, lt, asc, desc, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, schema, dbAll, dbGet, dbRun } from '../db/index.js';

/** Enrich raw message rows with parsed images and their tool calls */
async function enrichMessages(
  messages: (typeof schema.messages.$inferSelect)[],
  allToolCalls?: (typeof schema.toolCalls.$inferSelect)[],
) {
  const messageIds = messages.map((m) => m.id);
  const toolCalls =
    allToolCalls ??
    (messageIds.length > 0
      ? await dbAll(
          db
            .select()
            .from(schema.toolCalls)
            .where(
              messageIds.length === 1
                ? eq(schema.toolCalls.messageId, messageIds[0])
                : inArray(schema.toolCalls.messageId, messageIds),
            ),
        )
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
export async function getThreadWithMessages(id: string, messageLimit?: number) {
  const thread = await dbGet(db.select().from(schema.threads).where(eq(schema.threads.id, id)));
  if (!thread) return null;

  let messages;
  let hasMore = false;

  if (messageLimit) {
    const rows = await dbAll(
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.threadId, id))
        .orderBy(desc(schema.messages.timestamp))
        .limit(messageLimit + 1),
    );

    hasMore = rows.length > messageLimit;
    messages = (hasMore ? rows.slice(0, messageLimit) : rows).reverse();
  } else {
    messages = await dbAll(
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.threadId, id))
        .orderBy(asc(schema.messages.timestamp)),
    );
  }

  return {
    ...thread,
    messages: await enrichMessages(messages),
    hasMore,
    initInfo: thread.initTools
      ? {
          tools: JSON.parse(thread.initTools) as string[],
          cwd: thread.initCwd ?? '',
          model: thread.model ?? '',
        }
      : undefined,
  };
}

/** Get paginated messages for a thread, older than cursor.
 *  Returns messages in ASC order (oldest first). */
export async function getThreadMessages(opts: {
  threadId: string;
  cursor?: string;
  limit: number;
}): Promise<{
  messages: Awaited<ReturnType<typeof enrichMessages>>;
  hasMore: boolean;
}> {
  const { threadId, cursor, limit } = opts;

  const rows = await dbAll(
    db
      .select()
      .from(schema.messages)
      .where(
        cursor
          ? and(eq(schema.messages.threadId, threadId), lt(schema.messages.timestamp, cursor))
          : eq(schema.messages.threadId, threadId),
      )
      .orderBy(desc(schema.messages.timestamp))
      .limit(limit + 1),
  );

  const hasMore = rows.length > limit;
  const sliced = (hasMore ? rows.slice(0, limit) : rows).reverse();

  return { messages: await enrichMessages(sliced), hasMore };
}

/** Insert a new message, returns the generated ID */
export async function insertMessage(data: {
  threadId: string;
  role: string;
  content: string;
  images?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  author?: string | null;
}): Promise<string> {
  const id = nanoid();
  await dbRun(
    db.insert(schema.messages).values({
      id,
      threadId: data.threadId,
      role: data.role,
      content: data.content,
      images: data.images ?? null,
      model: data.model ?? null,
      permissionMode: data.permissionMode ?? null,
      author: data.author ?? null,
      timestamp: new Date().toISOString(),
    }),
  );
  return id;
}

/** Update message content (and optionally images) */
export async function updateMessage(
  id: string,
  data: string | { content: string; images?: string | null },
): Promise<void> {
  const updates =
    typeof data === 'string'
      ? { content: data, timestamp: new Date().toISOString() }
      : { content: data.content, images: data.images ?? null, timestamp: new Date().toISOString() };
  await dbRun(db.update(schema.messages).set(updates).where(eq(schema.messages.id, id)));
}
