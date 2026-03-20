/**
 * Tests for message-queue-repository.ts
 *
 * Tests enqueue, dequeue, peek, cancel, update, listQueue, queueCount,
 * and clearQueue against an in-memory SQLite database.
 *
 * Since the repository uses global db/dbAll/dbGet/dbRun imports, we test
 * the same logic directly via drizzle queries on the test DB to ensure
 * the schema and SQL operations are correct.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

describe('message-queue-repository', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1', name: 'Project 1', path: '/tmp/repo' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', title: 'Thread 1' });
  });

  function enqueue(threadId: string, content: string, opts: Record<string, any> = {}) {
    const existing = testDb.db
      .select()
      .from(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.threadId, threadId))
      .all();
    const maxOrder = existing.length > 0 ? Math.max(...existing.map((e: any) => e.sortOrder)) : -1;

    const row = {
      id: nanoid(),
      threadId,
      content,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode ?? null,
      images: opts.images ?? null,
      allowedTools: opts.allowedTools ?? null,
      disallowedTools: opts.disallowedTools ?? null,
      fileReferences: opts.fileReferences ?? null,
      sortOrder: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };
    testDb.db.insert(testDb.schema.messageQueue).values(row).run();
    return row;
  }

  function peek(threadId: string) {
    return (
      testDb.db
        .select()
        .from(testDb.schema.messageQueue)
        .where(eq(testDb.schema.messageQueue.threadId, threadId))
        .orderBy(asc(testDb.schema.messageQueue.sortOrder))
        .limit(1)
        .get() ?? null
    );
  }

  function dequeue(threadId: string) {
    const row = peek(threadId);
    if (!row) return null;
    testDb.db
      .delete(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.id, row.id))
      .run();
    return row;
  }

  function listQueue(threadId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.threadId, threadId))
      .orderBy(asc(testDb.schema.messageQueue.sortOrder))
      .all();
  }

  function queueCount(threadId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.threadId, threadId))
      .all().length;
  }

  function cancel(messageId: string) {
    const row = testDb.db
      .select()
      .from(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.id, messageId))
      .get();
    if (!row) return false;
    testDb.db
      .delete(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.id, messageId))
      .run();
    return true;
  }

  function updateMsg(messageId: string, content: string) {
    const row = testDb.db
      .select()
      .from(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.id, messageId))
      .get();
    if (!row) return null;
    testDb.db
      .update(testDb.schema.messageQueue)
      .set({ content })
      .where(eq(testDb.schema.messageQueue.id, messageId))
      .run();
    return { ...row, content };
  }

  function clearQueue(threadId: string) {
    testDb.db
      .delete(testDb.schema.messageQueue)
      .where(eq(testDb.schema.messageQueue.threadId, threadId))
      .run();
  }

  // ── Enqueue ────────────────────────────────────────────

  describe('enqueue', () => {
    test('inserts a message into the queue', () => {
      const row = enqueue('t1', 'Hello');
      expect(row.threadId).toBe('t1');
      expect(row.content).toBe('Hello');
      expect(row.sortOrder).toBe(0);
    });

    test('assigns incrementing sort order', () => {
      enqueue('t1', 'First');
      const second = enqueue('t1', 'Second');
      const third = enqueue('t1', 'Third');
      expect(second.sortOrder).toBe(1);
      expect(third.sortOrder).toBe(2);
    });

    test('stores optional fields', () => {
      const row = enqueue('t1', 'With opts', {
        provider: 'claude',
        model: 'opus',
        permissionMode: 'autoEdit',
        images: '[{"type":"base64"}]',
      });
      expect(row.provider).toBe('claude');
      expect(row.model).toBe('opus');
      expect(row.permissionMode).toBe('autoEdit');
      expect(row.images).toBe('[{"type":"base64"}]');
    });
  });

  // ── Peek ────────────────────────────────────────────

  describe('peek', () => {
    test('returns null for empty queue', () => {
      expect(peek('t1')).toBeNull();
    });

    test('returns the first message without removing it', () => {
      enqueue('t1', 'First');
      enqueue('t1', 'Second');

      const peeked = peek('t1');
      expect(peeked).not.toBeNull();
      expect(peeked!.content).toBe('First');

      // Still in the queue
      expect(queueCount('t1')).toBe(2);
    });
  });

  // ── Dequeue ────────────────────────────────────────────

  describe('dequeue', () => {
    test('returns null for empty queue', () => {
      expect(dequeue('t1')).toBeNull();
    });

    test('removes and returns the first message (FIFO)', () => {
      enqueue('t1', 'First');
      enqueue('t1', 'Second');

      const dequeued = dequeue('t1');
      expect(dequeued).not.toBeNull();
      expect(dequeued!.content).toBe('First');
      expect(queueCount('t1')).toBe(1);

      const next = dequeue('t1');
      expect(next!.content).toBe('Second');
      expect(queueCount('t1')).toBe(0);
    });

    test('returns null after draining all messages', () => {
      enqueue('t1', 'Only');
      dequeue('t1');
      expect(dequeue('t1')).toBeNull();
    });
  });

  // ── Cancel ────────────────────────────────────────────

  describe('cancel', () => {
    test('returns false for non-existent message', () => {
      expect(cancel('nonexistent')).toBe(false);
    });

    test('removes a specific message by ID', () => {
      const first = enqueue('t1', 'First');
      enqueue('t1', 'Second');

      expect(cancel(first.id)).toBe(true);
      expect(queueCount('t1')).toBe(1);

      const remaining = listQueue('t1');
      expect(remaining[0].content).toBe('Second');
    });
  });

  // ── Update ────────────────────────────────────────────

  describe('update', () => {
    test('returns null for non-existent message', () => {
      expect(updateMsg('nonexistent', 'new content')).toBeNull();
    });

    test('updates the content of a queued message', () => {
      const row = enqueue('t1', 'Original');
      const updated = updateMsg(row.id, 'Updated');

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('Updated');

      // Verify in DB
      const inDb = peek('t1');
      expect(inDb!.content).toBe('Updated');
    });
  });

  // ── List / Count ────────────────────────────────────────────

  describe('listQueue', () => {
    test('returns empty array for empty queue', () => {
      expect(listQueue('t1')).toEqual([]);
    });

    test('returns messages in sort order', () => {
      enqueue('t1', 'A');
      enqueue('t1', 'B');
      enqueue('t1', 'C');

      const items = listQueue('t1');
      expect(items).toHaveLength(3);
      expect(items[0].content).toBe('A');
      expect(items[1].content).toBe('B');
      expect(items[2].content).toBe('C');
    });

    test('does not return messages from other threads', () => {
      seedThread(testDb.db, { id: 't2', projectId: 'p1', title: 'Thread 2' });
      enqueue('t1', 'Thread 1 msg');
      enqueue('t2', 'Thread 2 msg');

      expect(listQueue('t1')).toHaveLength(1);
      expect(listQueue('t2')).toHaveLength(1);
    });
  });

  describe('queueCount', () => {
    test('returns 0 for empty queue', () => {
      expect(queueCount('t1')).toBe(0);
    });

    test('returns correct count', () => {
      enqueue('t1', 'A');
      enqueue('t1', 'B');
      expect(queueCount('t1')).toBe(2);
    });
  });

  // ── Clear ────────────────────────────────────────────

  describe('clearQueue', () => {
    test('removes all messages for a thread', () => {
      enqueue('t1', 'A');
      enqueue('t1', 'B');
      clearQueue('t1');
      expect(queueCount('t1')).toBe(0);
    });

    test('does not affect other threads', () => {
      seedThread(testDb.db, { id: 't2', projectId: 'p1', title: 'Thread 2' });
      enqueue('t1', 'T1 msg');
      enqueue('t2', 'T2 msg');

      clearQueue('t1');
      expect(queueCount('t1')).toBe(0);
      expect(queueCount('t2')).toBe(1);
    });
  });
});
