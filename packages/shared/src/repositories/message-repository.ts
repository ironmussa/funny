/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 *
 * DB-agnostic message repository. Accepts db + schema via dependency injection.
 */

import { eq, and, lt, asc, desc, inArray, like } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface MessageRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export function createMessageRepository(deps: MessageRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;

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
   *  When messageLimit is provided, returns ONLY the N most recent messages
   *  plus a hasMore flag — no server-side extension. The client extends the
   *  window in idle time via /messages, keeping the initial response small
   *  and the first paint fast. `lastUserMessage` is always included so the
   *  sticky prompt header can render immediately. */
  async function getThreadWithMessages(id: string, messageLimit?: number) {
    const thread = await dbGet(db.select().from(schema.threads).where(eq(schema.threads.id, id)));
    if (!thread) return null;

    let messages: (typeof schema.messages.$inferSelect)[];
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
      const collected = hasMore ? rows.slice(0, messageLimit) : rows;
      messages = collected.reverse();
    } else {
      messages = await dbAll(
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.threadId, id))
          .orderBy(asc(schema.messages.timestamp)),
      );
    }

    // Most-recent user message in the loaded window (messages is ASC here).
    let lastUserMessage: typeof schema.messages.$inferSelect | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMessage = messages[i];
        break;
      }
    }

    // Only fall back to a dedicated query when the window has no user message
    // (e.g. agent produced > MAX_TOTAL messages since the last prompt).
    if (!lastUserMessage) {
      const lastUserRow = await dbGet(
        db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.threadId, id), eq(schema.messages.role, 'user')))
          .orderBy(desc(schema.messages.timestamp))
          .limit(1),
      );
      lastUserMessage = lastUserRow ?? undefined;
    }

    // Single batched tool-calls fetch covering messages + lastUserMessage.
    const toolCallIds = messages.map((m) => m.id);
    const lastUserOutsideWindow =
      lastUserMessage && !messages.some((m) => m.id === lastUserMessage!.id);
    if (lastUserOutsideWindow && lastUserMessage) toolCallIds.push(lastUserMessage.id);

    const allToolCalls =
      toolCallIds.length > 0
        ? await dbAll(
            db
              .select()
              .from(schema.toolCalls)
              .where(
                toolCallIds.length === 1
                  ? eq(schema.toolCalls.messageId, toolCallIds[0])
                  : inArray(schema.toolCalls.messageId, toolCallIds),
              ),
          )
        : [];

    const enrichedMessages = await enrichMessages(messages, allToolCalls);
    const enrichedLastUser = lastUserMessage
      ? lastUserOutsideWindow
        ? (await enrichMessages([lastUserMessage], allToolCalls))[0]
        : enrichedMessages.find((m) => m.id === lastUserMessage!.id)
      : undefined;

    return {
      ...thread,
      messages: enrichedMessages,
      hasMore,
      lastUserMessage: enrichedLastUser,
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
  async function getThreadMessages(opts: {
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
  async function insertMessage(data: {
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
  async function updateMessage(
    id: string,
    data: string | { content: string; images?: string | null },
  ): Promise<void> {
    const updates =
      typeof data === 'string'
        ? { content: data, timestamp: new Date().toISOString() }
        : {
            content: data.content,
            images: data.images ?? null,
            timestamp: new Date().toISOString(),
          };
    await dbRun(db.update(schema.messages).set(updates).where(eq(schema.messages.id, id)));
  }

  /** Search messages within a thread by content substring.
   *  Returns matching message IDs, roles, timestamps and a snippet. */
  async function searchMessages(opts: {
    threadId: string;
    query: string;
    limit?: number;
    caseSensitive?: boolean;
  }): Promise<
    { messageId: string; role: string; content: string; timestamp: string; snippet: string }[]
  > {
    const { threadId, query, limit = 100, caseSensitive = false } = opts;
    const safeQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_');

    // SQL `LIKE` semantics differ across drivers (SQLite ASCII-insensitive, PG case-sensitive).
    // We use it as a coarse filter and apply the exact case-sensitivity rule in JS below.
    const rows = await dbAll(
      db
        .select({
          id: schema.messages.id,
          role: schema.messages.role,
          content: schema.messages.content,
          timestamp: schema.messages.timestamp,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.threadId, threadId),
            like(schema.messages.content, `%${safeQuery}%`),
          ),
        )
        .orderBy(asc(schema.messages.timestamp))
        .limit(limit),
    );

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: {
      messageId: string;
      role: string;
      content: string;
      timestamp: string;
      snippet: string;
    }[] = [];
    for (const row of rows) {
      const haystack = caseSensitive ? row.content : row.content.toLowerCase();
      const idx = haystack.indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(row.content.length, idx + needle.length + 60);
      let snippet = row.content.slice(start, end).replace(/\n/g, ' ');
      if (start > 0) snippet = '…' + snippet;
      if (end < row.content.length) snippet = snippet + '…';
      results.push({
        messageId: row.id,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        snippet,
      });
    }
    return results;
  }

  return {
    enrichMessages,
    getThreadWithMessages,
    getThreadMessages,
    searchMessages,
    insertMessage,
    updateMessage,
  };
}
