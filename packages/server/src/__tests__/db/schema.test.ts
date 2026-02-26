import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import {
  createTestDb,
  seedProject,
  seedThread,
  seedMessage,
  seedToolCall,
} from '../helpers/test-db.js';

describe('Database Schema', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  describe('projects table', () => {
    test('insert and select a project', () => {
      seedProject(testDb.db, { id: 'p1', name: 'Test', path: '/tmp/test' });

      const result = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(result).toBeTruthy();
      expect(result!.name).toBe('Test');
      expect(result!.path).toBe('/tmp/test');
      expect(result!.createdAt).toBeTruthy();
    });

    test('insert multiple projects', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      seedProject(testDb.db, { id: 'p3' });

      const all = testDb.db.select().from(testDb.schema.projects).all();
      expect(all).toHaveLength(3);
    });

    test('update a project', () => {
      seedProject(testDb.db, { id: 'p1', name: 'Old Name' });

      testDb.db
        .update(testDb.schema.projects)
        .set({ name: 'New Name' })
        .where(eq(testDb.schema.projects.id, 'p1'))
        .run();

      const updated = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(updated!.name).toBe('New Name');
    });

    test('delete a project', () => {
      seedProject(testDb.db, { id: 'p1' });
      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const result = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(result).toBeUndefined();
    });
  });

  describe('threads table', () => {
    test('insert and select a thread', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1', title: 'My Thread' });

      const result = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 't1'))
        .get();

      expect(result).toBeTruthy();
      expect(result!.title).toBe('My Thread');
      expect(result!.projectId).toBe('p1');
      expect(result!.status).toBe('pending');
      expect(result!.permissionMode).toBe('autoEdit');
    });

    test('thread defaults', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 't1'))
        .get();

      expect(thread!.cost).toBe(0);
      expect(thread!.archived).toBe(0);
      expect(thread!.sessionId).toBeNull();
      expect(thread!.completedAt).toBeNull();
    });

    test('update thread status', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      testDb.db
        .update(testDb.schema.threads)
        .set({ status: 'running' })
        .where(eq(testDb.schema.threads.id, 't1'))
        .run();

      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 't1'))
        .get();

      expect(thread!.status).toBe('running');
    });
  });

  describe('messages table', () => {
    test('insert and select a message', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1', role: 'user', content: 'Hello' });

      const result = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'm1'))
        .get();

      expect(result).toBeTruthy();
      expect(result!.role).toBe('user');
      expect(result!.content).toBe('Hello');
    });
  });

  describe('tool_calls table', () => {
    test('insert and select a tool call', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1', name: 'Read', input: '{}' });

      const result = testDb.db
        .select()
        .from(testDb.schema.toolCalls)
        .where(eq(testDb.schema.toolCalls.id, 'tc1'))
        .get();

      expect(result).toBeTruthy();
      expect(result!.name).toBe('Read');
      expect(result!.messageId).toBe('m1');
    });
  });

  describe('cascade deletes', () => {
    test('deleting a project cascades to threads', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const threads = testDb.db.select().from(testDb.schema.threads).all();
      expect(threads).toHaveLength(0);
    });

    test('deleting a thread cascades to messages', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't1' });

      testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, 't1')).run();

      const messages = testDb.db.select().from(testDb.schema.messages).all();
      expect(messages).toHaveLength(0);
    });

    test('deleting a message cascades to tool_calls', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1' });
      seedToolCall(testDb.db, { id: 'tc2', messageId: 'm1' });

      testDb.db.delete(testDb.schema.messages).where(eq(testDb.schema.messages.id, 'm1')).run();

      const toolCalls = testDb.db.select().from(testDb.schema.toolCalls).all();
      expect(toolCalls).toHaveLength(0);
    });

    test('full cascade: project → threads → messages → tool_calls', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedToolCall(testDb.db, { id: 'tc1', messageId: 'm1' });

      // Delete project - everything should cascade
      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      expect(testDb.db.select().from(testDb.schema.projects).all()).toHaveLength(0);
      expect(testDb.db.select().from(testDb.schema.threads).all()).toHaveLength(0);
      expect(testDb.db.select().from(testDb.schema.messages).all()).toHaveLength(0);
      expect(testDb.db.select().from(testDb.schema.toolCalls).all()).toHaveLength(0);
    });

    test('cascade does not affect unrelated data', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProject(testDb.db, { id: 'p2' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p2' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
      seedMessage(testDb.db, { id: 'm2', threadId: 't2' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      expect(testDb.db.select().from(testDb.schema.projects).all()).toHaveLength(1);
      expect(testDb.db.select().from(testDb.schema.threads).all()).toHaveLength(1);
      expect(testDb.db.select().from(testDb.schema.messages).all()).toHaveLength(1);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    test('duplicate primary key throws', () => {
      seedProject(testDb.db, { id: 'dup-1' });
      expect(() => seedProject(testDb.db, { id: 'dup-1' })).toThrow();
    });

    test('very long string in content field', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const longContent = 'a'.repeat(100_000);
      testDb.db
        .insert(testDb.schema.messages)
        .values({
          id: 'long-msg',
          threadId: 't1',
          role: 'assistant',
          content: longContent,
          timestamp: new Date().toISOString(),
        })
        .run();

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'long-msg'))
        .get();

      expect(msg!.content.length).toBe(100_000);
    });

    test('SQL special characters in content are stored safely', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      const dangerous = "Robert'); DROP TABLE messages;--";
      testDb.db
        .insert(testDb.schema.messages)
        .values({
          id: 'sql-inject',
          threadId: 't1',
          role: 'user',
          content: dangerous,
          timestamp: new Date().toISOString(),
        })
        .run();

      // Table still exists and content is stored literally
      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'sql-inject'))
        .get();
      expect(msg!.content).toBe(dangerous);

      // Messages table still works
      const count = testDb.db.select().from(testDb.schema.messages).all();
      expect(count.length).toBeGreaterThan(0);
    });

    test('unicode content in all fields', () => {
      seedProject(testDb.db, { id: 'uni-p', name: '日本語プロジェクト', path: '/tmp/日本語' });
      seedThread(testDb.db, { id: 'uni-t', projectId: 'uni-p', title: '🚀 Thread タイトル' });
      seedMessage(testDb.db, { id: 'uni-m', threadId: 'uni-t', content: '絵文字 🎉🔥 content' });

      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'uni-p'))
        .get();
      expect(project!.name).toBe('日本語プロジェクト');

      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 'uni-t'))
        .get();
      expect(thread!.title).toBe('🚀 Thread タイトル');

      const msg = testDb.db
        .select()
        .from(testDb.schema.messages)
        .where(eq(testDb.schema.messages.id, 'uni-m'))
        .get();
      expect(msg!.content).toBe('絵文字 🎉🔥 content');
    });

    test('null optional fields are stored correctly', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, {
        id: 'null-t',
        projectId: 'p1',
        branch: null,
        worktreePath: null,
        sessionId: null,
        completedAt: null,
      });

      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 'null-t'))
        .get();

      expect(thread!.branch).toBeNull();
      expect(thread!.worktreePath).toBeNull();
      expect(thread!.sessionId).toBeNull();
      expect(thread!.completedAt).toBeNull();
    });

    test('tool_call with null input and output', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });

      testDb.db
        .insert(testDb.schema.toolCalls)
        .values({
          id: 'tc-null',
          messageId: 'm1',
          name: 'Read',
          input: null,
          output: null,
        })
        .run();

      const tc = testDb.db
        .select()
        .from(testDb.schema.toolCalls)
        .where(eq(testDb.schema.toolCalls.id, 'tc-null'))
        .get();

      expect(tc!.input).toBeNull();
      expect(tc!.output).toBeNull();
    });

    test('cost field stores decimal values accurately', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 'cost-t', projectId: 'p1', cost: 0.00347 });

      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, 'cost-t'))
        .get();

      expect(thread!.cost).toBeCloseTo(0.00347, 5);
    });

    test('foreign key constraint prevents orphan threads', () => {
      expect(() => {
        testDb.db
          .insert(testDb.schema.threads)
          .values({
            id: 'orphan-t',
            projectId: 'nonexistent-project',
            title: 'Orphan',
            mode: 'local',
            permissionMode: 'autoEdit',
            status: 'pending',
            cost: 0,
            archived: 0,
            createdAt: new Date().toISOString(),
          })
          .run();
      }).toThrow();
    });

    test('foreign key constraint prevents orphan messages', () => {
      expect(() => {
        testDb.db
          .insert(testDb.schema.messages)
          .values({
            id: 'orphan-m',
            threadId: 'nonexistent-thread',
            role: 'user',
            content: 'Hello',
            timestamp: new Date().toISOString(),
          })
          .run();
      }).toThrow();
    });
  });
});
