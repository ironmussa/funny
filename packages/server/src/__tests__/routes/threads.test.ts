/**
 * Integration tests for thread routes (server-owned operations only).
 *
 * Tests data CRUD, comments, queue, and search. Does NOT test
 * runner-proxied operations (POST /, POST /idle, POST /:id/message, etc.).
 */

import { mock } from 'bun:test';

// Set env vars before any module imports
process.env.RUNNER_AUTH_SECRET = 'test-secret';

// Mock WebSocket/Socket.IO modules to prevent side effects
mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => false,
  relayToUser: () => {},
  broadcast: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch: () => Promise.reject(new Error('not available in test')),
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread, seedMessage, seedMessageQueue } from '../helpers/test-db.js';

describe('Thread Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
  });

  // ── GET /api/threads ───────────────────────────────────

  describe('GET /api/threads', () => {
    test('returns threads filtered by projectId', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedProject(t.db as any, { id: 'p2', userId: 'user-1', path: '/b' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        title: 'Thread 1',
        userId: 'user-1',
      });
      seedThread(t.db as any, {
        id: 't2',
        projectId: 'p2',
        title: 'Thread 2',
        userId: 'user-1',
      });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe('Thread 1');
    });

    test('scopes threads to the requesting user', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Mine' });
      seedThread(t.db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1');
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe('Mine');
    });
  });

  // ── GET /api/threads/:id ───────────────────────────────

  describe('GET /api/threads/:id', () => {
    test('returns thread with messages', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        title: 'Test Thread',
        userId: 'user-1',
      });
      seedMessage(t.db as any, {
        id: 'msg1',
        threadId: 't1',
        role: 'user',
        content: 'Hello',
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('Test Thread');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('Hello');
    });

    test('returns 404 for non-existent thread', async () => {
      const res = await t.requestAs('user-1').get('/api/threads/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/threads/:id ─────────────────────────────

  describe('PATCH /api/threads/:id', () => {
    test('updates thread title', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        title: 'Old Title',
        userId: 'user-1',
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        title: 'New Title',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('New Title');
    });

    test('archives a thread (boolean to integer conversion)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        archived: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.archived).toBe(1);
    });

    test('pins a thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        pinned: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pinned).toBe(1);
    });

    test('updates stage', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        stage: 'in_progress',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stage).toBe('in_progress');
    });

    test('returns 404 for non-existent thread', async () => {
      const res = await t.requestAs('user-1').patch('/api/threads/nonexistent', {
        title: 'X',
      });
      expect(res.status).toBe(404);
    });

    test('ignores non-allowed fields', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        title: 'Original',
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        id: 'hacked-id',
        projectId: 'hacked-project',
        userId: 'hacked-user',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // None of the forbidden fields should be changed
      expect(body.id).toBe('t1');
      expect(body.projectId).toBe('p1');
      expect(body.userId).toBe('user-1');
    });
  });

  // ── DELETE /api/threads/:id ────────────────────────────

  describe('DELETE /api/threads/:id', () => {
    test('deletes thread from DB', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').delete('/api/threads/t1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify thread is gone
      const getRes = await t.requestAs('user-1').get('/api/threads/t1');
      expect(getRes.status).toBe(404);
    });
  });

  // ── Comments ───────────────────────────────────────────

  describe('POST /api/threads/:id/comments', () => {
    test('creates a comment (201)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/comments', {
        content: 'This is a comment',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.content).toBe('This is a comment');
      expect(body.userId).toBe('user-1');
      expect(body.id).toBeTruthy();
    });

    test('returns 400 when content is missing', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/comments', {});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/threads/:id/comments', () => {
    test('returns empty array when no comments', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/comments');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    test('returns comments after creation', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      // Create two comments
      await t.requestAs('user-1').post('/api/threads/t1/comments', { content: 'First' });
      await t.requestAs('user-1').post('/api/threads/t1/comments', { content: 'Second' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/comments');
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe('DELETE /api/threads/:id/comments/:commentId', () => {
    test('removes a comment', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      // Create then delete
      const createRes = await t.requestAs('user-1').post('/api/threads/t1/comments', {
        content: 'To remove',
      });
      const { id } = await createRes.json();

      const delRes = await t.requestAs('user-1').delete(`/api/threads/t1/comments/${id}`);
      expect(delRes.status).toBe(200);

      // Verify it's gone
      const listRes = await t.requestAs('user-1').get('/api/threads/t1/comments');
      const body = await listRes.json();
      expect(body).toHaveLength(0);
    });
  });

  // ── Queue operations ───────────────────────────────────

  describe('GET /api/threads/:id/queue', () => {
    test('returns empty queue', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/queue');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    test('returns queued messages', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, {
        id: 'q1',
        threadId: 't1',
        content: 'Queued msg',
        sortOrder: 0,
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1/queue');
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].content).toBe('Queued msg');
    });
  });

  describe('DELETE /api/threads/:id/queue/:messageId', () => {
    test('cancels a queued message', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't1', content: 'Cancel me' });

      const res = await t.requestAs('user-1').delete('/api/threads/t1/queue/q1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.queuedCount).toBe(0);
    });
  });

  describe('PATCH /api/threads/:id/queue/:messageId', () => {
    test('updates queued message content', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't1', content: 'Original' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/queue/q1', {
        content: 'Updated content',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.message.content).toBe('Updated content');
    });

    test('returns 400 when content is missing', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/queue/q1', {});
      expect(res.status).toBe(400);
    });
  });

  // ── Search ─────────────────────────────────────────────

  describe('GET /api/threads/search/content', () => {
    test('returns empty when query is blank', async () => {
      const res = await t.requestAs('user-1').get('/api/threads/search/content?q=');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threadIds).toEqual([]);
    });

    test('returns matching thread IDs via LIKE search', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessage(t.db as any, {
        id: 'msg1',
        threadId: 't1',
        role: 'assistant',
        content: 'The quick brown fox jumps over the lazy dog',
      });

      const res = await t
        .requestAs('user-1')
        .get('/api/threads/search/content?q=brown+fox&projectId=p1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threadIds).toContain('t1');
      expect(body.snippets['t1']).toBeTruthy();
    });
  });
});
