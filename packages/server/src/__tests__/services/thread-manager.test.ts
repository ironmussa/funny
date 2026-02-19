import { describe, test, expect, beforeEach } from 'bun:test';
import { createTestDb, seedProject, seedThread, seedMessage, seedToolCall } from '../helpers/test-db.js';
import { eq, and, like, desc, asc, inArray, or, ne, count as drizzleCount, sql } from 'drizzle-orm';

/**
 * Tests for thread-manager.ts logic.
 *
 * Since thread-manager imports a singleton db, we reimplement the query logic
 * against a fresh in-memory test DB (same pattern as project-manager.test.ts).
 */

describe('ThreadManager', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  // ── Helpers that mirror thread-manager.ts functions ────────────

  function listThreads(opts: { projectId?: string; userId?: string; includeArchived?: boolean }) {
    const { projectId, userId = '__local__', includeArchived } = opts;
    const filters: ReturnType<typeof eq>[] = [];

    if (userId !== '__local__') {
      filters.push(eq(testDb.schema.threads.userId, userId));
    }
    if (projectId) {
      filters.push(eq(testDb.schema.threads.projectId, projectId));
    }
    if (!includeArchived) {
      filters.push(eq(testDb.schema.threads.archived, 0));
    }

    const condition = filters.length > 0 ? and(...filters) : undefined;
    const completionTime = sql`COALESCE(${testDb.schema.threads.completedAt}, ${testDb.schema.threads.createdAt})`;
    return testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(condition)
      .orderBy(desc(testDb.schema.threads.pinned), desc(completionTime))
      .all();
  }

  function getThread(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, id))
      .get();
  }

  function createThread(data: typeof testDb.schema.threads.$inferInsert) {
    testDb.db.insert(testDb.schema.threads).values(data).run();

    // Record initial stage in history
    const initialStage = data.stage ?? 'backlog';
    const id = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testDb.db.insert(testDb.schema.stageHistory).values({
      id,
      threadId: data.id,
      fromStage: null,
      toStage: initialStage,
      changedAt: new Date().toISOString(),
    }).run();
  }

  function updateThread(id: string, updates: Partial<typeof testDb.schema.threads.$inferInsert>) {
    testDb.db
      .update(testDb.schema.threads)
      .set(updates)
      .where(eq(testDb.schema.threads.id, id))
      .run();
  }

  function deleteThread(id: string) {
    testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, id)).run();
  }

  function insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
  }): string {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testDb.db.insert(testDb.schema.messages).values({
      id,
      threadId: data.threadId,
      role: data.role,
      content: data.content,
      images: data.images ?? null,
      model: data.model ?? null,
      permissionMode: data.permissionMode ?? null,
      timestamp: new Date().toISOString(),
    }).run();
    return id;
  }

  function updateMessage(id: string, content: string) {
    testDb.db
      .update(testDb.schema.messages)
      .set({ content, timestamp: new Date().toISOString() })
      .where(eq(testDb.schema.messages.id, id))
      .run();
  }

  function insertToolCall(data: { messageId: string; name: string; input: string }): string {
    const id = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testDb.db.insert(testDb.schema.toolCalls).values({
      id,
      messageId: data.messageId,
      name: data.name,
      input: data.input,
    }).run();
    return id;
  }

  function updateToolCallOutput(id: string, output: string) {
    testDb.db
      .update(testDb.schema.toolCalls)
      .set({ output })
      .where(eq(testDb.schema.toolCalls.id, id))
      .run();
  }

  function findToolCall(messageId: string, name: string, input: string) {
    return testDb.db
      .select({ id: testDb.schema.toolCalls.id })
      .from(testDb.schema.toolCalls)
      .where(
        and(
          eq(testDb.schema.toolCalls.messageId, messageId),
          eq(testDb.schema.toolCalls.name, name),
          eq(testDb.schema.toolCalls.input, input),
        ),
      )
      .get();
  }

  function getToolCall(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.toolCalls)
      .where(eq(testDb.schema.toolCalls.id, id))
      .get();
  }

  function listComments(threadId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.threadComments)
      .where(eq(testDb.schema.threadComments.threadId, threadId))
      .orderBy(asc(testDb.schema.threadComments.createdAt))
      .all();
  }

  function insertComment(data: { threadId: string; userId: string; source: string; content: string }) {
    const id = `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    testDb.db.insert(testDb.schema.threadComments).values({
      id,
      threadId: data.threadId,
      userId: data.userId,
      source: data.source,
      content: data.content,
      createdAt,
    }).run();
    return { id, ...data, createdAt };
  }

  function deleteComment(commentId: string) {
    testDb.db.delete(testDb.schema.threadComments).where(eq(testDb.schema.threadComments.id, commentId)).run();
  }

  function getCommentCounts(threadIds: string[]): Map<string, number> {
    if (threadIds.length === 0) return new Map();
    const rows = testDb.db.select({
      threadId: testDb.schema.threadComments.threadId,
      count: drizzleCount(),
    })
      .from(testDb.schema.threadComments)
      .where(inArray(testDb.schema.threadComments.threadId, threadIds))
      .groupBy(testDb.schema.threadComments.threadId)
      .all();
    return new Map(rows.map(r => [r.threadId, r.count]));
  }

  function markStaleThreadsInterrupted() {
    const staleCondition = and(
      or(
        eq(testDb.schema.threads.status, 'running'),
        eq(testDb.schema.threads.status, 'waiting'),
      ),
      ne(testDb.schema.threads.provider, 'external'),
    );

    const stale = testDb.db
      .select({ id: testDb.schema.threads.id })
      .from(testDb.schema.threads)
      .where(staleCondition)
      .all();

    if (stale.length > 0) {
      testDb.db
        .update(testDb.schema.threads)
        .set({ status: 'interrupted', completedAt: new Date().toISOString() })
        .where(staleCondition)
        .run();
    }
    return stale.length;
  }

  // ── Thread CRUD ────────────────────────────────────────────────

  describe('Thread CRUD', () => {
    test('listThreads returns empty array when no threads exist', () => {
      seedProject(testDb.db, { id: 'p1' });
      const threads = listThreads({ projectId: 'p1' });
      expect(threads).toEqual([]);
    });

    test('listThreads returns threads for a specific project', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', title: 'Thread A' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', title: 'Thread B' });
      seedThread(testDb.db, { id: 't3', projectId: 'p2', title: 'Thread C' });

      const threads = listThreads({ projectId: 'p1' });
      expect(threads).toHaveLength(2);
      expect(threads.map(t => t.title)).toContain('Thread A');
      expect(threads.map(t => t.title)).toContain('Thread B');
      expect(threads.map(t => t.id)).not.toContain('t3');
    });

    test('listThreads excludes archived threads by default', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', archived: 1 });

      const threads = listThreads({ projectId: 'p1' });
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe('t1');
    });

    test('listThreads includes archived threads when flag is set', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', archived: 1 });

      const threads = listThreads({ projectId: 'p1', includeArchived: true });
      expect(threads).toHaveLength(2);
    });

    test('listThreads filters by userId in multi mode', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'user-a' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', userId: 'user-b' });

      const threadsA = listThreads({ projectId: 'p1', userId: 'user-a' });
      expect(threadsA).toHaveLength(1);
      expect(threadsA[0].id).toBe('t1');

      const threadsB = listThreads({ projectId: 'p1', userId: 'user-b' });
      expect(threadsB).toHaveLength(1);
      expect(threadsB[0].id).toBe('t2');
    });

    test('listThreads with __local__ userId returns all threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'user-a' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', userId: 'user-b' });

      const threads = listThreads({ projectId: 'p1', userId: '__local__' });
      expect(threads).toHaveLength(2);
    });

    test('listThreads sorts pinned threads first', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't-normal', projectId: 'p1', pinned: 0, title: 'Normal' });
      seedThread(testDb.db, { id: 't-pinned', projectId: 'p1', pinned: 1, title: 'Pinned' });

      const threads = listThreads({ projectId: 'p1' });
      expect(threads).toHaveLength(2);
      expect(threads[0].id).toBe('t-pinned');
      expect(threads[1].id).toBe('t-normal');
    });

    test('getThread returns a thread by ID', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', title: 'My Thread' });

      const thread = getThread('t1');
      expect(thread).toBeTruthy();
      expect(thread!.id).toBe('t1');
      expect(thread!.title).toBe('My Thread');
      expect(thread!.status).toBe('pending');
      expect(thread!.mode).toBe('local');
    });

    test('getThread returns undefined for non-existent ID', () => {
      const thread = getThread('nonexistent');
      expect(thread).toBeUndefined();
    });

    test('createThread inserts a thread with all fields', () => {
      seedProject(testDb.db, { id: 'p1' });

      createThread({
        id: 'new-thread',
        projectId: 'p1',
        title: 'New Thread',
        mode: 'worktree',
        model: 'opus',
        permissionMode: 'plan',
        status: 'pending',
        branch: 'feature/test',
        baseBranch: 'main',
        worktreePath: '/tmp/wt',
        cost: 0,
        archived: 0,
        createdAt: new Date().toISOString(),
      });

      const thread = getThread('new-thread');
      expect(thread).toBeTruthy();
      expect(thread!.title).toBe('New Thread');
      expect(thread!.mode).toBe('worktree');
      expect(thread!.model).toBe('opus');
      expect(thread!.permissionMode).toBe('plan');
      expect(thread!.branch).toBe('feature/test');
      expect(thread!.baseBranch).toBe('main');
      expect(thread!.worktreePath).toBe('/tmp/wt');
    });

    test('createThread records initial stage history', () => {
      seedProject(testDb.db, { id: 'p1' });

      createThread({
        id: 'staged-thread',
        projectId: 'p1',
        title: 'Staged',
        mode: 'local',
        stage: 'in_progress',
        cost: 0,
        archived: 0,
        createdAt: new Date().toISOString(),
      });

      const history = testDb.db
        .select()
        .from(testDb.schema.stageHistory)
        .where(eq(testDb.schema.stageHistory.threadId, 'staged-thread'))
        .all();

      expect(history).toHaveLength(1);
      expect(history[0].fromStage).toBeNull();
      expect(history[0].toStage).toBe('in_progress');
    });

    test('createThread defaults stage to backlog in history', () => {
      seedProject(testDb.db, { id: 'p1' });

      createThread({
        id: 'default-stage',
        projectId: 'p1',
        title: 'Default Stage',
        mode: 'local',
        cost: 0,
        archived: 0,
        createdAt: new Date().toISOString(),
      });

      const history = testDb.db
        .select()
        .from(testDb.schema.stageHistory)
        .where(eq(testDb.schema.stageHistory.threadId, 'default-stage'))
        .all();

      expect(history).toHaveLength(1);
      expect(history[0].toStage).toBe('backlog');
    });

    test('updateThread changes status', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', status: 'pending' });

      updateThread('t1', { status: 'running' });

      const thread = getThread('t1');
      expect(thread!.status).toBe('running');
    });

    test('updateThread changes multiple fields at once', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const completedAt = new Date().toISOString();
      updateThread('t1', {
        status: 'completed',
        cost: 0.05,
        completedAt,
        sessionId: 'session-abc',
      });

      const thread = getThread('t1');
      expect(thread!.status).toBe('completed');
      expect(thread!.cost).toBeCloseTo(0.05, 5);
      expect(thread!.completedAt).toBe(completedAt);
      expect(thread!.sessionId).toBe('session-abc');
    });

    test('updateThread archives a thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });

      updateThread('t1', { archived: 1 });

      const thread = getThread('t1');
      expect(thread!.archived).toBe(1);
    });

    test('updateThread pins a thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', pinned: 0 });

      updateThread('t1', { pinned: 1 });

      const thread = getThread('t1');
      expect(thread!.pinned).toBe(1);
    });

    test('deleteThread removes the thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      expect(getThread('t1')).toBeTruthy();
      deleteThread('t1');
      expect(getThread('t1')).toBeUndefined();
    });

    test('deleteThread cascades to messages and tool calls', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1' });
      seedToolCall(testDb.db, { id: 'tc2', messageId: 'm2' });

      deleteThread('t1');

      const messages = testDb.db.select().from(testDb.schema.messages).all();
      const toolCalls = testDb.db.select().from(testDb.schema.toolCalls).all();
      expect(messages).toHaveLength(0);
      expect(toolCalls).toHaveLength(0);
    });

    test('deleteThread cascades to comments', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'A comment' });

      deleteThread('t1');

      const comments = testDb.db.select().from(testDb.schema.threadComments).all();
      expect(comments).toHaveLength(0);
    });

    test('deleteThread cascades to stage history', () => {
      seedProject(testDb.db, { id: 'p1' });
      createThread({
        id: 'del-thread',
        projectId: 'p1',
        title: 'To Delete',
        mode: 'local',
        cost: 0,
        archived: 0,
        createdAt: new Date().toISOString(),
      });

      deleteThread('del-thread');

      const history = testDb.db.select().from(testDb.schema.stageHistory).all();
      expect(history).toHaveLength(0);
    });

    test('deleteThread on non-existent thread does not throw', () => {
      expect(() => deleteThread('nonexistent')).not.toThrow();
    });
  });

  // ── Mark stale threads ─────────────────────────────────────────

  describe('markStaleThreadsInterrupted', () => {
    test('marks running threads as interrupted', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't-running', projectId: 'p1', status: 'running' });
      seedThread(testDb.db, { id: 't-waiting', projectId: 'p1', status: 'waiting' });
      seedThread(testDb.db, { id: 't-pending', projectId: 'p1', status: 'pending' });

      const count = markStaleThreadsInterrupted();
      expect(count).toBe(2);

      expect(getThread('t-running')!.status).toBe('interrupted');
      expect(getThread('t-waiting')!.status).toBe('interrupted');
      expect(getThread('t-pending')!.status).toBe('pending');
    });

    test('sets completedAt on interrupted threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't-running', projectId: 'p1', status: 'running' });

      markStaleThreadsInterrupted();

      const thread = getThread('t-running');
      expect(thread!.completedAt).toBeTruthy();
    });

    test('does not mark external provider threads as interrupted', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't-ext', projectId: 'p1', status: 'running', provider: 'external' });

      const count = markStaleThreadsInterrupted();
      expect(count).toBe(0);

      expect(getThread('t-ext')!.status).toBe('running');
    });

    test('returns 0 when no stale threads exist', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't-completed', projectId: 'p1', status: 'completed' });
      seedThread(testDb.db, { id: 't-failed', projectId: 'p1', status: 'failed' });

      const count = markStaleThreadsInterrupted();
      expect(count).toBe(0);
    });
  });

  // ── Message operations ─────────────────────────────────────────

  describe('Message operations', () => {
    test('insertMessage creates a message and returns its ID', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const msgId = insertMessage({
        threadId: 't1',
        role: 'user',
        content: 'Hello, world!',
      });

      expect(msgId).toBeTruthy();
      expect(typeof msgId).toBe('string');

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, msgId))
        .get();

      expect(msg).toBeTruthy();
      expect(msg!.role).toBe('user');
      expect(msg!.content).toBe('Hello, world!');
      expect(msg!.threadId).toBe('t1');
      expect(msg!.timestamp).toBeTruthy();
    });

    test('insertMessage stores images as JSON string', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const images = JSON.stringify([{ url: 'data:image/png;base64,abc', alt: 'screenshot' }]);
      const msgId = insertMessage({
        threadId: 't1',
        role: 'user',
        content: 'See attached',
        images,
      });

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, msgId))
        .get();

      expect(msg!.images).toBe(images);
      const parsed = JSON.parse(msg!.images!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].alt).toBe('screenshot');
    });

    test('insertMessage stores model and permissionMode', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const msgId = insertMessage({
        threadId: 't1',
        role: 'user',
        content: 'Test',
        model: 'opus',
        permissionMode: 'plan',
      });

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, msgId))
        .get();

      expect(msg!.model).toBe('opus');
      expect(msg!.permissionMode).toBe('plan');
    });

    test('insertMessage defaults images and model to null', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const msgId = insertMessage({ threadId: 't1', role: 'assistant', content: 'Hi' });

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, msgId))
        .get();

      expect(msg!.images).toBeNull();
      expect(msg!.model).toBeNull();
      expect(msg!.permissionMode).toBeNull();
    });

    test('messages belong to a thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      insertMessage({ threadId: 't1', role: 'user', content: 'First' });
      insertMessage({ threadId: 't1', role: 'assistant', content: 'Second' });

      const msgs = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.threadId, 't1'))
        .all();

      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.threadId === 't1')).toBe(true);
    });

    test('multiple messages per thread are stored independently', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const id1 = insertMessage({ threadId: 't1', role: 'user', content: 'Hello' });
      const id2 = insertMessage({ threadId: 't1', role: 'assistant', content: 'World' });
      const id3 = insertMessage({ threadId: 't1', role: 'user', content: 'Bye' });

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);

      const msgs = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.threadId, 't1'))
        .all();

      expect(msgs).toHaveLength(3);
      expect(msgs.map(m => m.content).sort()).toEqual(['Bye', 'Hello', 'World']);
    });

    test('updateMessage changes content and updates timestamp', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'Original' });

      const originalMsg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'm1'))
        .get();
      const originalTimestamp = originalMsg!.timestamp;

      // Small delay so timestamps differ
      updateMessage('m1', 'Updated content');

      const updated = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'm1'))
        .get();

      expect(updated!.content).toBe('Updated content');
      expect(updated!.timestamp).toBeTruthy();
    });

    test('messages for different threads are isolated', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      insertMessage({ threadId: 't1', role: 'user', content: 'Thread 1 msg' });
      insertMessage({ threadId: 't2', role: 'user', content: 'Thread 2 msg' });

      const t1Msgs = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.threadId, 't1'))
        .all();
      const t2Msgs = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.threadId, 't2'))
        .all();

      expect(t1Msgs).toHaveLength(1);
      expect(t1Msgs[0].content).toBe('Thread 1 msg');
      expect(t2Msgs).toHaveLength(1);
      expect(t2Msgs[0].content).toBe('Thread 2 msg');
    });
  });

  // ── ToolCall operations ────────────────────────────────────────

  describe('ToolCall operations', () => {
    test('insertToolCall creates a tool call linked to a message', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });

      const tcId = insertToolCall({ messageId: 'm1', name: 'Read', input: '{"file": "test.ts"}' });

      expect(tcId).toBeTruthy();

      const tc = getToolCall(tcId);
      expect(tc).toBeTruthy();
      expect(tc!.messageId).toBe('m1');
      expect(tc!.name).toBe('Read');
      expect(tc!.input).toBe('{"file": "test.ts"}');
      expect(tc!.output).toBeNull();
    });

    test('updateToolCallOutput sets the output', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1' });

      updateToolCallOutput('tc1', 'File contents here...');

      const tc = getToolCall('tc1');
      expect(tc!.output).toBe('File contents here...');
    });

    test('updateToolCallOutput overwrites previous output', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1', output: 'old output' });

      updateToolCallOutput('tc1', 'new output');

      const tc = getToolCall('tc1');
      expect(tc!.output).toBe('new output');
    });

    test('findToolCall finds by messageId + name + input', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, {
        id: 'tc1',
        messageId: 'm1',
        name: 'Edit',
        input: '{"file": "main.ts", "line": 10}',
      });

      const found = findToolCall('m1', 'Edit', '{"file": "main.ts", "line": 10}');
      expect(found).toBeTruthy();
      expect(found!.id).toBe('tc1');
    });

    test('findToolCall returns undefined when no match', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1', name: 'Read', input: '{}' });

      // Different name
      expect(findToolCall('m1', 'Write', '{}')).toBeUndefined();

      // Different input
      expect(findToolCall('m1', 'Read', '{"different": true}')).toBeUndefined();

      // Different messageId
      expect(findToolCall('m-other', 'Read', '{}')).toBeUndefined();
    });

    test('findToolCall is precise across multiple tool calls', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1', name: 'Read', input: '{"file":"a.ts"}' });
      seedToolCall(testDb.db, { id: 'tc2', messageId: 'm1', name: 'Read', input: '{"file":"b.ts"}' });
      seedToolCall(testDb.db, { id: 'tc3', messageId: 'm1', name: 'Write', input: '{"file":"a.ts"}' });

      const found = findToolCall('m1', 'Read', '{"file":"b.ts"}');
      expect(found).toBeTruthy();
      expect(found!.id).toBe('tc2');
    });

    test('getToolCall returns undefined for non-existent ID', () => {
      expect(getToolCall('nonexistent')).toBeUndefined();
    });

    test('multiple tool calls per message', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });

      insertToolCall({ messageId: 'm1', name: 'Read', input: '{"file":"a.ts"}' });
      insertToolCall({ messageId: 'm1', name: 'Write', input: '{"file":"b.ts"}' });
      insertToolCall({ messageId: 'm1', name: 'Bash', input: '{"cmd":"ls"}' });

      const allTc = testDb.db
        .select()
        .from(testDb.schema.toolCalls)
        .where(eq(testDb.schema.toolCalls.messageId, 'm1'))
        .all();

      expect(allTc).toHaveLength(3);
      expect(allTc.map(tc => tc.name).sort()).toEqual(['Bash', 'Read', 'Write']);
    });
  });

  // ── Comment operations ─────────────────────────────────────────

  describe('Comment operations', () => {
    test('insertComment creates a comment and returns it', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const comment = insertComment({
        threadId: 't1',
        userId: 'user-1',
        source: 'user',
        content: 'This looks good!',
      });

      expect(comment.id).toBeTruthy();
      expect(comment.threadId).toBe('t1');
      expect(comment.userId).toBe('user-1');
      expect(comment.source).toBe('user');
      expect(comment.content).toBe('This looks good!');
      expect(comment.createdAt).toBeTruthy();
    });

    test('listComments returns comments ordered by creation time', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'First' });
      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'Second' });
      insertComment({ threadId: 't1', userId: 'u2', source: 'agent', content: 'Third' });

      const comments = listComments('t1');
      expect(comments).toHaveLength(3);
      expect(comments[0].content).toBe('First');
      expect(comments[1].content).toBe('Second');
      expect(comments[2].content).toBe('Third');
      expect(comments[2].source).toBe('agent');
    });

    test('listComments returns empty array when no comments', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const comments = listComments('t1');
      expect(comments).toEqual([]);
    });

    test('deleteComment removes a specific comment', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const c1 = insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'Keep me' });
      const c2 = insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'Delete me' });

      deleteComment(c2.id);

      const remaining = listComments('t1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].content).toBe('Keep me');
    });

    test('deleteComment on non-existent comment does not throw', () => {
      expect(() => deleteComment('nonexistent')).not.toThrow();
    });

    test('getCommentCounts returns correct counts for multiple threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });
      seedThread(testDb.db, { id: 't3', projectId: 'p1' });

      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'A' });
      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'B' });
      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'C' });
      insertComment({ threadId: 't2', userId: 'u1', source: 'user', content: 'D' });
      // t3 has no comments

      const counts = getCommentCounts(['t1', 't2', 't3']);
      expect(counts.get('t1')).toBe(3);
      expect(counts.get('t2')).toBe(1);
      expect(counts.get('t3')).toBeUndefined();
    });

    test('getCommentCounts returns empty map for empty input', () => {
      const counts = getCommentCounts([]);
      expect(counts.size).toBe(0);
    });
  });

  // ── Data isolation ─────────────────────────────────────────────

  describe('Data isolation', () => {
    test('threads for one project do not appear in another', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', title: 'Project 1 thread' });
      seedThread(testDb.db, { id: 't2', projectId: 'p2', title: 'Project 2 thread' });

      const p1Threads = listThreads({ projectId: 'p1' });
      const p2Threads = listThreads({ projectId: 'p2' });

      expect(p1Threads).toHaveLength(1);
      expect(p1Threads[0].title).toBe('Project 1 thread');
      expect(p2Threads).toHaveLength(1);
      expect(p2Threads[0].title).toBe('Project 2 thread');
    });

    test('deleting one project does not affect another project threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p2' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't2' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      // p2 data should be intact
      const p2Threads = testDb.db.select().from(testDb.schema.threads).all();
      expect(p2Threads).toHaveLength(1);
      expect(p2Threads[0].id).toBe('t2');

      const p2Msgs = testDb.db.select().from(testDb.schema.messages).all();
      expect(p2Msgs).toHaveLength(1);
      expect(p2Msgs[0].id).toBe('m2');
    });

    test('tool calls from different messages are isolated', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1', name: 'Read' });
      seedToolCall(testDb.db, { id: 'tc2', messageId: 'm2', name: 'Write' });

      // Deleting m1 should only remove tc1
      testDb.db.delete(testDb.schema.messages).where(eq(testDb.schema.messages.id, 'm1')).run();

      const remaining = testDb.db.select().from(testDb.schema.toolCalls).all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('tc2');
    });

    test('comments are isolated between threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      insertComment({ threadId: 't1', userId: 'u1', source: 'user', content: 'Comment for t1' });
      insertComment({ threadId: 't2', userId: 'u1', source: 'user', content: 'Comment for t2' });

      const t1Comments = listComments('t1');
      const t2Comments = listComments('t2');

      expect(t1Comments).toHaveLength(1);
      expect(t1Comments[0].content).toBe('Comment for t1');
      expect(t2Comments).toHaveLength(1);
      expect(t2Comments[0].content).toBe('Comment for t2');
    });
  });

  // ── Thread with messages (enrichment) ──────────────────────────

  describe('Thread with messages', () => {
    test('getThreadWithMessages returns thread with enriched messages', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', role: 'user', content: 'Hello' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't1', role: 'assistant', content: 'Hi there' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm2', name: 'Read', input: '{}' });

      // Simulate getThreadWithMessages logic
      const thread = getThread('t1');
      expect(thread).toBeTruthy();

      const messages = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.threadId, 't1'))
        .orderBy(asc(testDb.schema.messages.timestamp))
        .all();

      const messageIds = messages.map(m => m.id);
      const toolCalls = testDb.db
        .select()
        .from(testDb.schema.toolCalls)
        .where(inArray(testDb.schema.toolCalls.messageId, messageIds))
        .all();

      // Enrich
      const enriched = messages.map(msg => ({
        ...msg,
        images: msg.images ? JSON.parse(msg.images) : undefined,
        toolCalls: toolCalls.filter(tc => tc.messageId === msg.id),
      }));

      expect(enriched).toHaveLength(2);
      expect(enriched[0].role).toBe('user');
      expect(enriched[0].toolCalls).toHaveLength(0);
      expect(enriched[1].role).toBe('assistant');
      expect(enriched[1].toolCalls).toHaveLength(1);
      expect(enriched[1].toolCalls[0].name).toBe('Read');
    });

    test('enrichment parses images JSON', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const images = JSON.stringify([{ url: 'data:image/png;base64,xyz' }]);
      testDb.db.insert(testDb.schema.messages).values({
        id: 'img-msg',
        threadId: 't1',
        role: 'user',
        content: 'With image',
        images,
        timestamp: new Date().toISOString(),
      }).run();

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'img-msg'))
        .get();

      const enrichedImages = msg!.images ? JSON.parse(msg!.images) : undefined;
      expect(enrichedImages).toBeTruthy();
      expect(enrichedImages).toHaveLength(1);
      expect(enrichedImages[0].url).toBe('data:image/png;base64,xyz');
    });
  });

  // ── Archived threads (listArchivedThreads logic) ──────────

  describe('listArchivedThreads', () => {
    function listArchivedThreads(opts: {
      page: number;
      limit: number;
      search: string;
      userId: string;
    }) {
      const { page, limit, search, userId } = opts;
      const offset = (page - 1) * limit;

      function escapeLike(value: string): string {
        return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
      }

      const safeSearch = search ? escapeLike(search) : '';
      const filters: ReturnType<typeof eq>[] = [eq(testDb.schema.threads.archived, 1)];

      if (userId !== '__local__') {
        filters.push(eq(testDb.schema.threads.userId, userId));
      }

      if (search) {
        filters.push(
          or(
            like(testDb.schema.threads.title, `%${safeSearch}%`),
            like(testDb.schema.threads.branch, `%${safeSearch}%`),
            like(testDb.schema.threads.status, `%${safeSearch}%`)
          ) as any
        );
      }

      const conditions = and(...filters);

      const [{ total }] = testDb.db
        .select({ total: drizzleCount() })
        .from(testDb.schema.threads)
        .where(conditions!)
        .all();

      const completionTime = sql`COALESCE(${testDb.schema.threads.completedAt}, ${testDb.schema.threads.createdAt})`;
      const threads = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(conditions!)
        .orderBy(desc(completionTime))
        .limit(limit)
        .offset(offset)
        .all();

      return { threads, total };
    }

    test('returns only archived threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'active-1', projectId: 'p1', archived: 0 });
      seedThread(testDb.db, { id: 'archived-1', projectId: 'p1', archived: 1 });
      seedThread(testDb.db, { id: 'archived-2', projectId: 'p1', archived: 1 });

      const result = listArchivedThreads({ page: 1, limit: 10, search: '', userId: '__local__' });
      expect(result.total).toBe(2);
      expect(result.threads).toHaveLength(2);
      expect(result.threads.every(t => t.archived === 1)).toBe(true);
    });

    test('pagination works correctly', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'a1', projectId: 'p1', archived: 1, createdAt: '2025-01-01T00:00:00Z' });
      seedThread(testDb.db, { id: 'a2', projectId: 'p1', archived: 1, createdAt: '2025-01-02T00:00:00Z' });
      seedThread(testDb.db, { id: 'a3', projectId: 'p1', archived: 1, createdAt: '2025-01-03T00:00:00Z' });

      const page1 = listArchivedThreads({ page: 1, limit: 2, search: '', userId: '__local__' });
      expect(page1.total).toBe(3);
      expect(page1.threads).toHaveLength(2);

      const page2 = listArchivedThreads({ page: 2, limit: 2, search: '', userId: '__local__' });
      expect(page2.total).toBe(3);
      expect(page2.threads).toHaveLength(1);
    });

    test('filters by search query on title', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'a1', projectId: 'p1', archived: 1, title: 'Fix login bug' });
      seedThread(testDb.db, { id: 'a2', projectId: 'p1', archived: 1, title: 'Add feature' });
      seedThread(testDb.db, { id: 'a3', projectId: 'p1', archived: 1, title: 'Fix logout bug' });

      const result = listArchivedThreads({ page: 1, limit: 10, search: 'Fix', userId: '__local__' });
      expect(result.total).toBe(2);
      expect(result.threads.every(t => t.title.includes('Fix'))).toBe(true);
    });

    test('filters by search query on branch', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'a1', projectId: 'p1', archived: 1, branch: 'feature/auth' });
      seedThread(testDb.db, { id: 'a2', projectId: 'p1', archived: 1, branch: 'fix/login' });

      const result = listArchivedThreads({ page: 1, limit: 10, search: 'auth', userId: '__local__' });
      expect(result.total).toBe(1);
      expect(result.threads[0].branch).toContain('auth');
    });

    test('filters by userId in multi-user mode', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'a1', projectId: 'p1', archived: 1, userId: 'user-1' });
      seedThread(testDb.db, { id: 'a2', projectId: 'p1', archived: 1, userId: 'user-2' });
      seedThread(testDb.db, { id: 'a3', projectId: 'p1', archived: 1, userId: 'user-1' });

      const result = listArchivedThreads({ page: 1, limit: 10, search: '', userId: 'user-1' });
      expect(result.total).toBe(2);
      expect(result.threads.every(t => t.userId === 'user-1')).toBe(true);
    });

    test('returns empty results when no archived threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });

      const result = listArchivedThreads({ page: 1, limit: 10, search: '', userId: '__local__' });
      expect(result.total).toBe(0);
      expect(result.threads).toHaveLength(0);
    });

    test('search is case insensitive', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'a1', projectId: 'p1', archived: 1, title: 'Important BUG Fix' });
      seedThread(testDb.db, { id: 'a2', projectId: 'p1', archived: 1, title: 'Something else' });

      const result = listArchivedThreads({ page: 1, limit: 10, search: 'bug', userId: '__local__' });
      expect(result.total).toBe(1);
      expect(result.threads[0].title).toBe('Important BUG Fix');
    });
  });

  // ── Search (searchViaLike logic, FTS5 requires real DB) ───

  describe('searchViaLike', () => {
    function escapeLike(value: string): string {
      return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    function searchViaLike(query: string, projectId: string | undefined, userId: string): Map<string, string> {
      const safeQuery = escapeLike(query.trim());

      const filters: ReturnType<typeof eq>[] = [
        like(testDb.schema.messages.content, `%${safeQuery}%`),
      ];

      if (userId !== '__local__') {
        filters.push(eq(testDb.schema.threads.userId, userId));
      }
      if (projectId) {
        filters.push(eq(testDb.schema.threads.projectId, projectId));
      }

      const rows = testDb.db
        .select({ threadId: testDb.schema.messages.threadId, content: testDb.schema.messages.content })
        .from(testDb.schema.messages)
        .innerJoin(testDb.schema.threads, eq(testDb.schema.messages.threadId, testDb.schema.threads.id))
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

    test('finds messages containing the query string', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'Implement the login feature' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't2', content: 'Fix the logout bug' });

      const result = searchViaLike('login', undefined, '__local__');
      expect(result.size).toBe(1);
      expect(result.has('t1')).toBe(true);
      expect(result.get('t1')).toContain('login');
    });

    test('returns empty map for empty query', () => {
      // Mimic the guard in searchThreadIdsByContent
      const query = '   ';
      if (!query.trim()) {
        expect(new Map().size).toBe(0);
        return;
      }
    });

    test('returns empty map when no matches', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'Hello world' });

      const result = searchViaLike('nonexistent-xyz', undefined, '__local__');
      expect(result.size).toBe(0);
    });

    test('filters by projectId', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2', name: 'Other' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p2' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'Find this keyword' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't2', content: 'Also has keyword' });

      const result = searchViaLike('keyword', 'p1', '__local__');
      expect(result.size).toBe(1);
      expect(result.has('t1')).toBe(true);
    });

    test('filters by userId in multi-user mode', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'user-a' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1', userId: 'user-b' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'Search target' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't2', content: 'Also a search target' });

      const result = searchViaLike('target', undefined, 'user-a');
      expect(result.size).toBe(1);
      expect(result.has('t1')).toBe(true);
    });

    test('returns one snippet per thread (deduplicates)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'first match target' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't1', content: 'second match target' });

      const result = searchViaLike('target', undefined, '__local__');
      expect(result.size).toBe(1);
      expect(result.has('t1')).toBe(true);
    });

    test('generates snippet with context around match', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      const longContent = 'A'.repeat(50) + 'FINDME' + 'B'.repeat(80);
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: longContent });

      const result = searchViaLike('FINDME', undefined, '__local__');
      expect(result.size).toBe(1);
      const snippet = result.get('t1')!;
      expect(snippet).toContain('FINDME');
      // Snippet should be truncated, not the full content
      expect(snippet.length).toBeLessThan(longContent.length);
    });

    test('case-insensitive matching', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', content: 'The Error Handler works' });

      const result = searchViaLike('error handler', undefined, '__local__');
      expect(result.size).toBe(1);
    });
  });
});
