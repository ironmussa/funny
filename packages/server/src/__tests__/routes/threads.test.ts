import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { createTestDb, seedProject, seedThread, seedMessage, seedToolCall } from '../helpers/test-db.js';

describe('Thread Routes', () => {
  let app: Hono;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();

    app = new Hono();

    // GET /
    app.get('/', (c) => {
      const projectId = c.req.query('projectId');
      const includeArchived = c.req.query('includeArchived') === 'true';

      if (projectId) {
        const conditions = includeArchived
          ? eq(testDb.schema.threads.projectId, projectId)
          : and(eq(testDb.schema.threads.projectId, projectId), eq(testDb.schema.threads.archived, 0));
        const threads = testDb.db.select().from(testDb.schema.threads).where(conditions).all();
        return c.json(threads);
      }

      if (includeArchived) {
        return c.json(testDb.db.select().from(testDb.schema.threads).all());
      }

      return c.json(testDb.db.select().from(testDb.schema.threads).where(eq(testDb.schema.threads.archived, 0)).all());
    });

    // GET /:id
    app.get('/:id', (c) => {
      const id = c.req.param('id');
      const thread = testDb.db.select().from(testDb.schema.threads).where(eq(testDb.schema.threads.id, id)).get();
      if (!thread) return c.json({ error: 'Thread not found' }, 404);

      const messages = testDb.db.select().from(testDb.schema.messages).where(eq(testDb.schema.messages.threadId, id)).all();
      const toolCalls = testDb.db.select().from(testDb.schema.toolCalls).all();
      const messagesWithTools = messages.map((msg) => ({
        ...msg,
        toolCalls: toolCalls.filter((tc) => tc.messageId === msg.id),
      }));

      return c.json({ ...thread, messages: messagesWithTools });
    });

    // PATCH /:id
    app.patch('/:id', async (c) => {
      const id = c.req.param('id');
      const body = await c.req.json<{ archived?: boolean }>();

      const thread = testDb.db.select().from(testDb.schema.threads).where(eq(testDb.schema.threads.id, id)).get();
      if (!thread) return c.json({ error: 'Thread not found' }, 404);

      const updates: Record<string, any> = {};
      if (body.archived !== undefined) {
        updates.archived = body.archived ? 1 : 0;
      }

      if (Object.keys(updates).length > 0) {
        testDb.db.update(testDb.schema.threads).set(updates).where(eq(testDb.schema.threads.id, id)).run();
      }

      const updated = testDb.db.select().from(testDb.schema.threads).where(eq(testDb.schema.threads.id, id)).get();
      return c.json(updated);
    });

    // DELETE /:id
    app.delete('/:id', (c) => {
      const id = c.req.param('id');
      testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, id)).run();
      return c.json({ ok: true });
    });
  });

  test('GET / returns empty array when no threads', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('GET / returns non-archived threads', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });
    seedThread(testDb.db, { id: 't2', projectId: 'p1', archived: 1 });

    const res = await app.request('/');
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('t1');
  });

  test('GET /?includeArchived=true returns all threads', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });
    seedThread(testDb.db, { id: 't2', projectId: 'p1', archived: 1 });

    const res = await app.request('/?includeArchived=true');
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  test('GET /?projectId=p1 filters by project', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedProject(testDb.db, { id: 'p2' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
    seedThread(testDb.db, { id: 't2', projectId: 'p2' });

    const res = await app.request('/?projectId=p1');
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].projectId).toBe('p1');
  });

  test('GET /:id returns thread with messages and tool calls', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
    seedMessage(testDb.db, { id: 'msg1', threadId: 't1', role: 'user', content: 'Hello' });
    seedMessage(testDb.db, { id: 'msg2', threadId: 't1', role: 'assistant', content: 'Hi' });
    seedToolCall(testDb.db, { id: 'tc1', messageId: 'msg2', name: 'Read' });

    const res = await app.request('/t1');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe('t1');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].toolCalls).toHaveLength(1);
    expect(body.messages[1].toolCalls[0].name).toBe('Read');
  });

  test('GET /:id returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent');
    expect(res.status).toBe(404);
  });

  test('PATCH /:id archives a thread', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 0 });

    const res = await app.request('/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(1);
  });

  test('PATCH /:id unarchives a thread', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', archived: 1 });

    const res = await app.request('/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(0);
  });

  test('PATCH /:id returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(404);
  });

  test('DELETE /:id removes the thread', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const threads = testDb.db.select().from(testDb.schema.threads).all();
    expect(threads).toHaveLength(0);
  });

  test('DELETE /:id cascades to messages', async () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
    seedMessage(testDb.db, { id: 'msg1', threadId: 't1' });

    await app.request('/t1', { method: 'DELETE' });

    const messages = testDb.db.select().from(testDb.schema.messages).all();
    expect(messages).toHaveLength(0);
  });
});
