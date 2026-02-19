import { eq, and, or, ne, asc, desc, lt, inArray, like, count as drizzleCount, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

/** Escape SQL LIKE wildcards so user input is treated as literal text */
function escapeLike(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Record a stage transition in the history table */
function recordStageChange(threadId: string, fromStage: string | null, toStage: string) {
  const id = nanoid();
  db.insert(schema.stageHistory)
    .values({
      id,
      threadId,
      fromStage,
      toStage,
      changedAt: new Date().toISOString(),
    })
    .run();
}

// ── Thread CRUD ──────────────────────────────────────────────────

/** List threads, optionally filtered by projectId, userId, and archive status */
export function listThreads(opts: {
  projectId?: string;
  userId: string;
  includeArchived?: boolean;
}) {
  const { projectId, userId, includeArchived } = opts;
  const filters: ReturnType<typeof eq>[] = [];

  // In multi mode, filter by userId; in local mode (userId='__local__'), skip
  if (userId !== '__local__') {
    filters.push(eq(schema.threads.userId, userId));
  }

  if (projectId) {
    filters.push(eq(schema.threads.projectId, projectId));
  }

  if (!includeArchived) {
    filters.push(eq(schema.threads.archived, 0));
  }

  const condition = filters.length > 0 ? and(...filters) : undefined;
  // Sort by pinned first, then by completion time (most recent first), falling back to createdAt
  const completionTime = sql`COALESCE(${schema.threads.completedAt}, ${schema.threads.createdAt})`;
  const threads = db.select().from(schema.threads).where(condition).orderBy(desc(schema.threads.pinned), desc(completionTime)).all();

  // Enrich with comment counts
  if (threads.length > 0) {
    const counts = getCommentCounts(threads.map(t => t.id));
    return threads.map(t => ({ ...t, commentCount: counts.get(t.id) ?? 0 }));
  }
  return threads;
}

/** List archived threads with pagination and search */
export function listArchivedThreads(opts: {
  page: number;
  limit: number;
  search: string;
  userId: string;
}) {
  const { page, limit, search, userId } = opts;
  const offset = (page - 1) * limit;

  const safeSearch = search ? escapeLike(search) : '';
  const filters: ReturnType<typeof eq>[] = [eq(schema.threads.archived, 1)];

  if (userId !== '__local__') {
    filters.push(eq(schema.threads.userId, userId));
  }

  if (search) {
    filters.push(
      or(
        like(schema.threads.title, `%${safeSearch}%`),
        like(schema.threads.branch, `%${safeSearch}%`),
        like(schema.threads.status, `%${safeSearch}%`)
      ) as any
    );
  }

  const conditions = and(...filters);

  const [{ total }] = db
    .select({ total: drizzleCount() })
    .from(schema.threads)
    .where(conditions!)
    .all();

  // Sort by completion time (most recent first), falling back to createdAt
  const completionTime = sql`COALESCE(${schema.threads.completedAt}, ${schema.threads.createdAt})`;
  const threads = db
    .select()
    .from(schema.threads)
    .where(conditions!)
    .orderBy(desc(completionTime))
    .limit(limit)
    .offset(offset)
    .all();

  return { threads, total };
}

/** Get a single thread by ID */
export function getThread(id: string) {
  return db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
}

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

/** Insert a new thread */
export function createThread(data: typeof schema.threads.$inferInsert) {
  db.insert(schema.threads).values(data).run();

  // Record initial stage in history
  const initialStage = data.stage ?? 'backlog';
  recordStageChange(data.id, null, initialStage);
}

/** Update thread fields by ID */
export function updateThread(
  id: string,
  updates: Partial<{
    status: string;
    sessionId: string;
    cost: number;
    completedAt: string | null;
    archived: number;
    pinned: number;
    stage: string;
    branch: string | null;
    baseBranch: string | null;
    worktreePath: string | null;
    permissionMode: string;
    model: string;
    provider: string;
    initTools: string;
    initCwd: string;
  }>
) {
  // If stage is being updated, record the transition
  if (updates.stage !== undefined) {
    const currentThread = db.select({ stage: schema.threads.stage })
      .from(schema.threads)
      .where(eq(schema.threads.id, id))
      .get();

    if (currentThread && currentThread.stage !== updates.stage) {
      recordStageChange(id, currentThread.stage, updates.stage);
    }
  }

  // Record archiving/unarchiving as a stage transition
  if (updates.archived !== undefined) {
    const currentThread = db.select({ stage: schema.threads.stage, archived: schema.threads.archived })
      .from(schema.threads)
      .where(eq(schema.threads.id, id))
      .get();

    if (currentThread) {
      if (updates.archived === 1 && currentThread.archived === 0) {
        recordStageChange(id, currentThread.stage, 'archived');
      } else if (updates.archived === 0 && currentThread.archived === 1) {
        recordStageChange(id, 'archived', updates.stage ?? currentThread.stage);
      }
    }
  }

  db.update(schema.threads).set(updates).where(eq(schema.threads.id, id)).run();
}

/** Delete a thread (cascade deletes messages + tool_calls) */
export function deleteThread(id: string) {
  db.delete(schema.threads).where(eq(schema.threads.id, id)).run();
}

/** Mark stale (running/waiting) threads as interrupted. Called on server startup. */
export function markStaleThreadsInterrupted(): void {
  const staleCondition = and(
    or(
      eq(schema.threads.status, 'running'),
      eq(schema.threads.status, 'waiting'),
    ),
    ne(schema.threads.provider, 'external'),
  );

  const stale = db.select({ id: schema.threads.id })
    .from(schema.threads)
    .where(staleCondition)
    .all();

  if (stale.length > 0) {
    db.update(schema.threads)
      .set({ status: 'interrupted', completedAt: new Date().toISOString() })
      .where(staleCondition)
      .run();
    console.log(`[thread-manager] Marked ${stale.length} stale thread(s) as interrupted`);
  }
}

// ── Message CRUD ─────────────────────────────────────────────────

/** Insert a new message, returns the generated ID */
export function insertMessage(data: {
  threadId: string;
  role: string;
  content: string;
  images?: string | null;
  model?: string | null;
  permissionMode?: string | null;
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

// ── ToolCall CRUD ────────────────────────────────────────────────

/** Insert a new tool call, returns the generated ID */
export function insertToolCall(data: {
  messageId: string;
  name: string;
  input: string;
}): string {
  const id = nanoid();
  db.insert(schema.toolCalls)
    .values({
      id,
      messageId: data.messageId,
      name: data.name,
      input: data.input,
    })
    .run();
  return id;
}

/** Update tool call output */
export function updateToolCallOutput(id: string, output: string) {
  db.update(schema.toolCalls)
    .set({ output })
    .where(eq(schema.toolCalls.id, id))
    .run();
}

/** Find existing tool call by messageId + name + input (for deduplication) */
export function findToolCall(messageId: string, name: string, input: string) {
  return db.select({ id: schema.toolCalls.id })
    .from(schema.toolCalls)
    .where(and(
      eq(schema.toolCalls.messageId, messageId),
      eq(schema.toolCalls.name, name),
      eq(schema.toolCalls.input, input),
    ))
    .get();
}

/** Get a single tool call by ID */
export function getToolCall(id: string) {
  return db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, id)).get();
}

// ── Comment CRUD ──────────────────────────────────────────────────

/** List comments for a thread, ordered by creation time */
export function listComments(threadId: string) {
  return db.select()
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
    .values({ id, threadId: data.threadId, userId: data.userId, source: data.source, content: data.content, createdAt })
    .run();
  return { id, ...data, createdAt };
}

/** Delete a comment by ID */
export function deleteComment(commentId: string) {
  db.delete(schema.threadComments).where(eq(schema.threadComments.id, commentId)).run();
}

/** Escape FTS5 special characters so user input is treated as literal text.
 *  Wraps each term in double quotes to prevent FTS5 query syntax injection. */
function escapeFts5Query(value: string): string {
  // Split on whitespace and wrap each token in quotes to treat as literal
  return value.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Search for thread IDs whose messages contain the given query string.
 *  Uses FTS5 full-text index for fast search. Falls back to LIKE if FTS fails.
 *  Returns a Map of threadId → snippet for matching threads. */
export function searchThreadIdsByContent(opts: {
  query: string;
  projectId?: string;
  userId: string;
}): Map<string, string> {
  const { query, projectId, userId } = opts;
  if (!query.trim()) return new Map();

  try {
    return searchViaFts5(query, projectId, userId);
  } catch {
    // FTS table may not exist yet (e.g. during migration); fall back to LIKE
    return searchViaLike(query, projectId, userId);
  }
}

/** Fast path: FTS5 search with snippet() for highlighted context.
 *  Uses Drizzle sql template for proper parameterization. */
function searchViaFts5(query: string, projectId: string | undefined, userId: string): Map<string, string> {
  const ftsQuery = escapeFts5Query(query);

  // Build dynamic WHERE clause using Drizzle sql template for safe parameterization
  let stmt = sql`
    SELECT m.thread_id AS threadId, snippet(messages_fts, 0, '', '', '…', 30) AS snippet
    FROM messages_fts AS fts
    JOIN messages AS m ON m.rowid = fts.rowid
    JOIN threads AS t ON t.id = m.thread_id
    WHERE fts.content MATCH ${ftsQuery}
  `;

  if (userId !== '__local__') {
    stmt = sql`${stmt} AND t.user_id = ${userId}`;
  }
  if (projectId) {
    stmt = sql`${stmt} AND t.project_id = ${projectId}`;
  }

  stmt = sql`${stmt} GROUP BY m.thread_id`;

  const rows = db.all<{ threadId: string; snippet: string }>(stmt);
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.threadId, row.snippet.replace(/\n/g, ' '));
  }
  return result;
}

/** Slow fallback: LIKE-based search (used if FTS table doesn't exist yet) */
function searchViaLike(query: string, projectId: string | undefined, userId: string): Map<string, string> {
  const safeQuery = escapeLike(query.trim());

  const filters: ReturnType<typeof eq>[] = [
    like(schema.messages.content, `%${safeQuery}%`),
  ];

  if (userId !== '__local__') {
    filters.push(eq(schema.threads.userId, userId));
  }
  if (projectId) {
    filters.push(eq(schema.threads.projectId, projectId));
  }

  const rows = db
    .select({ threadId: schema.messages.threadId, content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
    .where(and(...filters))
    .all();

  const result = new Map<string, string>();
  const queryLower = query.trim().toLowerCase();
  for (const row of rows) {
    if (result.has(row.threadId)) continue;
    const idx = row.content.toLowerCase().indexOf(queryLower);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 30);
    const end = Math.min(row.content.length, idx + queryLower.length + 50);
    let snippet = row.content.slice(start, end).replace(/\n/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < row.content.length) snippet = snippet + '…';
    result.set(row.threadId, snippet);
  }

  return result;
}

/** Get comment counts for a list of thread IDs */
export function getCommentCounts(threadIds: string[]): Map<string, number> {
  if (threadIds.length === 0) return new Map();
  const rows = db.select({
    threadId: schema.threadComments.threadId,
    count: drizzleCount(),
  })
    .from(schema.threadComments)
    .where(inArray(schema.threadComments.threadId, threadIds))
    .groupBy(schema.threadComments.threadId)
    .all();
  return new Map(rows.map(r => [r.threadId, r.count]));
}
