import { eq, and, or, asc, desc, inArray, like, count as drizzleCount, sql } from 'drizzle-orm';
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
  return db.select().from(schema.threads).where(condition).orderBy(desc(schema.threads.pinned), desc(completionTime)).all();
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

/** Get a thread with its messages and tool calls */
export function getThreadWithMessages(id: string) {
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!thread) return null;

  const messages = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, id))
    .orderBy(asc(schema.messages.timestamp))
    .all();

  const messageIds = messages.map((m) => m.id);
  const toolCalls = messageIds.length > 0
    ? db.select().from(schema.toolCalls).where(
        messageIds.length === 1
          ? eq(schema.toolCalls.messageId, messageIds[0])
          : inArray(schema.toolCalls.messageId, messageIds)
      ).all()
    : [];

  const messagesWithTools = messages.map((msg) => ({
    ...msg,
    images: msg.images ? JSON.parse(msg.images) : undefined,
    toolCalls: toolCalls.filter((tc) => tc.messageId === msg.id),
  }));

  return { ...thread, messages: messagesWithTools };
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
  const staleCondition = or(
    eq(schema.threads.status, 'running'),
    eq(schema.threads.status, 'waiting'),
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
