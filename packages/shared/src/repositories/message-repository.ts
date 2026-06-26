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

import { eq, and, gt, lt, lte, asc, desc, inArray, sql } from 'drizzle-orm';
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

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const PERMISSION_PENDING_OUTPUT =
  /(?:requested permissions? to (?:use|edit)|is a sensitive file|hasn't been granted|hasn't granted|not in the allowed tools list|hook error:.*(?:approval|permission)|denied this tool|Blocked by hook|Waiting for user approval)/i;

async function findPendingWaitState(deps: MessageRepositoryDeps, threadId: string, status: string) {
  if (status !== 'waiting') return {};

  const { db, schema, dbAll } = deps;
  const latestToolCalls = await dbAll(
    db
      .select({
        id: schema.toolCalls.id,
        name: schema.toolCalls.name,
        input: schema.toolCalls.input,
        output: schema.toolCalls.output,
      })
      .from(schema.toolCalls)
      .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(desc(schema.messages.timestamp))
      .limit(25),
  );

  const pendingInteractive = latestToolCalls.find(
    (tc) => INTERACTIVE_TOOLS.has(tc.name) && !tc.output,
  );
  if (pendingInteractive?.name === 'AskUserQuestion') return { waitingReason: 'question' };
  if (pendingInteractive?.name === 'ExitPlanMode') return { waitingReason: 'plan' };

  const pendingPermission = latestToolCalls.find((tc) => {
    if (INTERACTIVE_TOOLS.has(tc.name)) return false;
    if (!tc.output) return true;
    return PERMISSION_PENDING_OUTPUT.test(tc.output);
  });
  if (!pendingPermission) return {};

  return {
    waitingReason: 'permission',
    pendingPermission: {
      toolName: pendingPermission.name,
      toolInput: pendingPermission.input,
    },
  };
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
  async function getThreadWithMessages(
    id: string,
    messageLimit?: number,
    opts: { messageProgress?: number; messageAnchorId?: string } = {},
  ) {
    const thread = await dbGet(db.select().from(schema.threads).where(eq(schema.threads.id, id)));
    if (!thread) return null;

    let messages: (typeof schema.messages.$inferSelect)[];
    let hasMore = false;
    let hasMoreAfter = false;
    let windowStart = 0;
    let leadingUserMessage: typeof schema.messages.$inferSelect | undefined;

    // Total message count for the thread. Paired with windowStart, this lets
    // clients understand where the loaded window sits within the full history.
    // Only needed when paginating (messageLimit set); a full load already knows
    // the total.
    let total: number | undefined;
    if (messageLimit) {
      total = await countThreadMessages(id);
    }

    if (messageLimit) {
      const maxStart = Math.max(0, (total ?? 0) - messageLimit);
      let targetIndex: number | undefined;
      const progress =
        typeof opts.messageProgress === 'number'
          ? Math.min(1, Math.max(0, opts.messageProgress))
          : 1;
      const anchorId =
        opts.messageAnchorId && !(typeof opts.messageProgress === 'number' && progress >= 0.999)
          ? opts.messageAnchorId
          : undefined;
      if (anchorId) {
        const anchorMessage =
          (await dbGet(
            db
              .select({ timestamp: schema.messages.timestamp })
              .from(schema.messages)
              .where(and(eq(schema.messages.threadId, id), eq(schema.messages.id, anchorId)))
              .limit(1),
          )) ??
          (await dbGet(
            db
              .select({ timestamp: schema.messages.timestamp })
              .from(schema.toolCalls)
              .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
              .where(and(eq(schema.messages.threadId, id), eq(schema.toolCalls.id, anchorId)))
              .limit(1),
          ));
        if (anchorMessage) {
          targetIndex = await countMessagesBefore(id, anchorMessage.timestamp);
        }
      }
      targetIndex ??= Math.round(Math.max(0, (total ?? 0) - 1) * progress);
      windowStart = Math.min(maxStart, Math.max(0, targetIndex - Math.floor(messageLimit / 2)));
      const rows = await dbAll(
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.threadId, id))
          .orderBy(asc(schema.messages.timestamp))
          .limit(messageLimit)
          .offset(windowStart),
      );
      messages = rows;
      hasMore = windowStart > 0;
      hasMoreAfter = windowStart + messages.length < (total ?? messages.length);
    } else {
      messages = await dbAll(
        db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.threadId, id))
          .orderBy(asc(schema.messages.timestamp)),
      );
    }

    if (messageLimit && messages.length > 0 && messages[0].role !== 'user') {
      leadingUserMessage = await findLeadingUserMessage(thread.id, messages[0]);
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

    // Single batched tool-calls fetch covering messages + context-only user messages.
    const toolCallIds = messages.map((m) => m.id);
    const lastUserOutsideWindow =
      lastUserMessage && !messages.some((m) => m.id === lastUserMessage!.id);
    if (lastUserOutsideWindow && lastUserMessage) toolCallIds.push(lastUserMessage.id);
    const leadingUserOutsideWindow =
      leadingUserMessage && !messages.some((m) => m.id === leadingUserMessage!.id);
    if (leadingUserOutsideWindow && leadingUserMessage) toolCallIds.push(leadingUserMessage.id);

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
    const enrichedLeadingUser = leadingUserMessage
      ? leadingUserOutsideWindow
        ? (await enrichMessages([leadingUserMessage], allToolCalls))[0]
        : enrichedMessages.find((m) => m.id === leadingUserMessage!.id)
      : undefined;
    const waitState = await findPendingWaitState(deps, id, thread.status);

    return {
      ...thread,
      messages: enrichedMessages,
      hasMore,
      hasMoreAfter,
      // When fully loaded (no messageLimit) the loaded window IS the total.
      total: total ?? enrichedMessages.length,
      windowStart,
      lastUserMessage: enrichedLastUser,
      leadingUserMessage: enrichedLeadingUser,
      initInfo: thread.initTools
        ? {
            tools: JSON.parse(thread.initTools) as string[],
            cwd: thread.initCwd ?? '',
            model: thread.model ?? '',
            slashCommands: thread.initSlashCommands
              ? (JSON.parse(thread.initSlashCommands) as string[])
              : undefined,
          }
        : undefined,
      ...waitState,
    };
  }

  /** Count all messages belonging to a thread. Cheap COUNT(*) over the
   *  threadId index, used for paginated-window metadata. */
  async function countThreadMessages(threadId: string): Promise<number> {
    const row = await dbGet(
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.messages)
        .where(eq(schema.messages.threadId, threadId)),
    );
    return Number(row?.count ?? 0);
  }

  /** Get paginated messages for a thread, older than cursor.
   *  Returns messages in ASC order (oldest first).
   *  `total` is the full message count so the client can describe the loaded
   *  window within the complete history. */
  async function getThreadMessages(opts: {
    threadId: string;
    cursor?: string;
    limit: number;
    direction?: 'before' | 'after';
  }): Promise<{
    messages: Awaited<ReturnType<typeof enrichMessages>>;
    hasMore: boolean;
    hasMoreAfter: boolean;
    total: number;
    windowStart: number;
    leadingUserMessage?: Awaited<ReturnType<typeof enrichMessages>>[number];
  }> {
    const { threadId, cursor, limit, direction = 'before' } = opts;

    const [rows, total] = await Promise.all([
      dbAll(
        db
          .select()
          .from(schema.messages)
          .where(
            cursor
              ? and(
                  eq(schema.messages.threadId, threadId),
                  direction === 'after'
                    ? gt(schema.messages.timestamp, cursor)
                    : lt(schema.messages.timestamp, cursor),
                )
              : eq(schema.messages.threadId, threadId),
          )
          .orderBy(
            direction === 'after'
              ? asc(schema.messages.timestamp)
              : desc(schema.messages.timestamp),
          )
          .limit(limit + 1),
      ),
      countThreadMessages(threadId),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const sliced = direction === 'after' ? page : page.reverse();
    const windowStart =
      sliced.length > 0 ? await countMessagesBefore(threadId, sliced[0].timestamp) : 0;
    const leadingUserMessage =
      sliced.length > 0 && sliced[0].role !== 'user'
        ? await findLeadingUserMessage(threadId, sliced[0])
        : undefined;

    return {
      messages: await enrichMessages(sliced),
      hasMore: direction === 'after' || cursor ? windowStart > 0 : hasMore,
      hasMoreAfter: direction === 'after' ? hasMore : windowStart + sliced.length < total,
      total,
      windowStart,
      leadingUserMessage: leadingUserMessage
        ? (await enrichMessages([leadingUserMessage]))[0]
        : undefined,
    };
  }

  async function countMessagesBefore(threadId: string, timestamp: string): Promise<number> {
    const row = await dbGet(
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.threadId, threadId), lt(schema.messages.timestamp, timestamp)),
        ),
    );
    return Number(row?.count ?? 0);
  }

  async function findLeadingUserMessage(
    threadId: string,
    firstMessage: typeof schema.messages.$inferSelect,
  ): Promise<typeof schema.messages.$inferSelect | undefined> {
    if (firstMessage.role === 'user') {
      return undefined;
    }

    const sectionUser = await dbGet(
      db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.threadId, threadId),
            eq(schema.messages.role, 'user'),
            lte(schema.messages.timestamp, firstMessage.timestamp),
          ),
        )
        .orderBy(desc(schema.messages.timestamp))
        .limit(1),
    );

    return sectionUser ?? undefined;
  }

  /** Insert a new message, returns the generated ID */
  async function insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
    author?: string | null;
    timestamp?: string | null;
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
        effort: data.effort ?? null,
        author: data.author ?? null,
        timestamp: data.timestamp ?? new Date().toISOString(),
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
    {
      messageId: string;
      role: string;
      content: string;
      timestamp: string;
      snippet: string;
    }[]
  > {
    const { threadId, query, limit = 100, caseSensitive = false } = opts;
    // Escape the LIKE wildcards (`%`, `_`) AND the escape char itself so a query
    // like `apply_patch` matches a literal underscore instead of "any char".
    // The matching `ESCAPE '\'` clause is REQUIRED — without it the backslash is
    // treated as a literal, so `apply\_patch` would never match `apply_patch`.
    const safeQuery = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);

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
            sql`${schema.messages.content} like ${`%${safeQuery}%`} escape '\\'`,
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

  /**
   * Delete all messages in a thread whose timestamp is strictly after the
   * given anchor message's timestamp. Tool calls cascade via FK.
   * Used by "Rewind code to here" to truncate the conversation.
   */
  async function deleteMessagesAfter(threadId: string, anchorMessageId: string): Promise<number> {
    const anchor = await dbGet(
      db
        .select({ timestamp: schema.messages.timestamp })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.threadId, threadId), eq(schema.messages.id, anchorMessageId)),
        ),
    );
    if (!anchor) return 0;

    const toDelete = await dbAll(
      db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.threadId, threadId),
            gt(schema.messages.timestamp, anchor.timestamp),
          ),
        ),
    );
    if (toDelete.length === 0) return 0;
    await dbRun(
      db.delete(schema.messages).where(
        inArray(
          schema.messages.id,
          toDelete.map((r) => r.id),
        ),
      ),
    );
    return toDelete.length;
  }

  return {
    enrichMessages,
    getThreadWithMessages,
    getThreadMessages,
    searchMessages,
    insertMessage,
    updateMessage,
    deleteMessagesAfter,
  };
}
