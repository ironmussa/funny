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
   *  When messageLimit is provided, returns only the N most recent messages
   *  plus a hasMore flag.  Always includes `lastUserMessage` so the UI can
   *  show the sticky prompt without loading all messages. */
  async function getThreadWithMessages(id: string, messageLimit?: number) {
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
      let collected = hasMore ? rows.slice(0, messageLimit) : rows;

      // Extend backwards until the oldest loaded message is a user message,
      // so the thread renders with its starting prompt visible without the
      // client needing a follow-up "Loading older messages…" round trip.
      // Capped to avoid runaway fetches on huge threads.
      const MAX_TOTAL = messageLimit * 5;
      while (
        hasMore &&
        collected.length < MAX_TOTAL &&
        collected.length > 0 &&
        collected[collected.length - 1].role !== 'user'
      ) {
        const oldest = collected[collected.length - 1];
        const moreRows = await dbAll(
          db
            .select()
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.threadId, id),
                lt(schema.messages.timestamp, oldest.timestamp),
              ),
            )
            .orderBy(desc(schema.messages.timestamp))
            .limit(messageLimit + 1),
        );
        const batchHasMore = moreRows.length > messageLimit;
        const batchSliced = batchHasMore ? moreRows.slice(0, messageLimit) : moreRows;
        collected = [...collected, ...batchSliced];
        hasMore = batchHasMore;
      }

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

    // Always fetch the last user message separately — it may not be in the
    // paginated window when the agent produced many tool calls after it.
    const lastUserRow = await dbGet(
      db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.threadId, id), eq(schema.messages.role, 'user')))
        .orderBy(desc(schema.messages.timestamp))
        .limit(1),
    );
    const [lastUserMessage] = lastUserRow ? await enrichMessages([lastUserRow]) : [undefined];

    return {
      ...thread,
      messages: await enrichMessages(messages),
      hasMore,
      lastUserMessage,
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
