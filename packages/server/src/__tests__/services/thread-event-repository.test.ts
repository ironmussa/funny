/**
 * Tests for thread-event-repository.ts
 *
 * Tests thread event CRUD against an in-memory SQLite database.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { eq, desc } from 'drizzle-orm';

import { createTestDb, seedProject, seedThread, seedThreadEvent } from '../helpers/test-db.js';

describe('thread-event-repository', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
  });

  test('create and retrieve a thread event', () => {
    seedThreadEvent(testDb.db, {
      id: 'evt-1',
      threadId: 't1',
      eventType: 'status_change',
      data: JSON.stringify({ from: 'pending', to: 'running' }),
    });

    const rows = testDb.db
      .select()
      .from(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.threadId, 't1'))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('status_change');

    const data = JSON.parse(rows[0].data);
    expect(data.from).toBe('pending');
    expect(data.to).toBe('running');
  });

  test('retrieve events ordered by creation time descending', () => {
    seedThreadEvent(testDb.db, {
      id: 'evt-old',
      threadId: 't1',
      eventType: 'started',
      createdAt: '2025-01-01T00:00:00Z',
    });
    seedThreadEvent(testDb.db, {
      id: 'evt-new',
      threadId: 't1',
      eventType: 'completed',
      createdAt: '2025-01-02T00:00:00Z',
    });

    const rows = testDb.db
      .select()
      .from(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.threadId, 't1'))
      .orderBy(desc(testDb.schema.threadEvents.createdAt))
      .all();

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('evt-new');
    expect(rows[1].id).toBe('evt-old');
  });

  test('delete all events for a thread', () => {
    seedThreadEvent(testDb.db, { id: 'evt-d1', threadId: 't1' });
    seedThreadEvent(testDb.db, { id: 'evt-d2', threadId: 't1' });

    // Create another thread with its own event
    seedThread(testDb.db, { id: 't2', projectId: 'p1' });
    seedThreadEvent(testDb.db, { id: 'evt-d3', threadId: 't2' });

    testDb.db
      .delete(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.threadId, 't1'))
      .run();

    const t1Events = testDb.db
      .select()
      .from(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.threadId, 't1'))
      .all();
    expect(t1Events).toHaveLength(0);

    // t2 events should remain
    const t2Events = testDb.db
      .select()
      .from(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.threadId, 't2'))
      .all();
    expect(t2Events).toHaveLength(1);
  });

  test('cascade delete removes events when thread is deleted', () => {
    seedThreadEvent(testDb.db, { id: 'evt-c1', threadId: 't1' });
    seedThreadEvent(testDb.db, { id: 'evt-c2', threadId: 't1' });

    testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, 't1')).run();

    const events = testDb.db.select().from(testDb.schema.threadEvents).all();
    expect(events).toHaveLength(0);
  });

  test('events store arbitrary JSON data', () => {
    const complexData = {
      agent: 'claude',
      metrics: { tokens: 1500, cost: 0.02 },
      tags: ['review', 'code-quality'],
    };

    seedThreadEvent(testDb.db, {
      id: 'evt-json',
      threadId: 't1',
      eventType: 'metrics',
      data: JSON.stringify(complexData),
    });

    const row = testDb.db
      .select()
      .from(testDb.schema.threadEvents)
      .where(eq(testDb.schema.threadEvents.id, 'evt-json'))
      .get();

    const parsed = JSON.parse(row!.data);
    expect(parsed.agent).toBe('claude');
    expect(parsed.metrics.tokens).toBe(1500);
    expect(parsed.tags).toEqual(['review', 'code-quality']);
  });
});
