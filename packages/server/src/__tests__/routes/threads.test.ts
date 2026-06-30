/**
 * Integration tests for thread routes (server-owned operations only).
 *
 * Tests data CRUD, comments, queue, and search. Does NOT test
 * runner-proxied operations (POST /, POST /idle, POST /:id/message, etc.).
 */

import { mock } from 'bun:test';

// Set env vars before any module imports
process.env.RUNNER_AUTH_SECRET = 'test-secret';

const relayCalls: Array<{ userId: string; event: Record<string, unknown> }> = [];
const threadViewerCalls: Array<{ threadId: string; event: Record<string, unknown> }> = [];

// Mock WebSocket/Socket.IO modules to prevent side effects. Must export EVERY
// symbol any app module binds from ws-relay (ESM binding is checked at import
// time) — capture the two we assert on, no-op the rest.
mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => false,
  getRunnerSocketId: () => null,
  userHasConnectedRunner: () => false,
  relayToUser: (userId: string, event: Record<string, unknown>) => {
    relayCalls.push({ userId, event });
  },
  broadcast: () => {},
  threadStreamRoom: (id: string) => `thread:${id}:stream`,
  threadPresenceRoom: (id: string) => `thread:${id}:presence`,
  relayToThreadStream: () => {},
  relayToThreadPresence: () => {},
  relayToThreadViewers: (threadId: string, event: Record<string, unknown>) => {
    threadViewerCalls.push({ threadId, event });
  },
  evictUserFromThread: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch: () => Promise.reject(new Error('not available in test')),
  TunnelTimeoutError: class TunnelTimeoutError extends Error {
    name = 'TunnelTimeoutError';
  },
  isTunnelTimeoutError: () => false,
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  seedProject,
  seedThread,
  seedMessage,
  seedMessageQueue,
  seedThreadEvent,
  seedToolCall,
} from '../helpers/test-db.js';

describe('Thread Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    relayCalls.length = 0;
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
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].title).toBe('Thread 1');
    });

    test('scopes threads to the requesting user', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Mine' });
      seedThread(t.db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

      const res = await t.requestAs('user-1').get('/api/threads?projectId=p1');
      const body = await res.json();
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].title).toBe('Mine');
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

    /*
     * Security CR-4 — `worktreePath` is intentionally NOT in the PATCH
     * allow-list. It's set exclusively by the runtime's `createWorktree`
     * flow and identifies a directory the runner trusts as cwd. Letting
     * clients overwrite it lets them pivot the runner to /etc, another
     * user's HOME, etc., bypassing path-scope checks.
     */
    test('PATCH refuses to set worktreePath even when supplied (CR-4)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      // Attacker tries to PATCH the cwd to /etc — the field is not in the
      // allow-list so the update must NOT apply.
      const res = await t.requestAs('user-1').patch('/api/threads/t1', {
        worktreePath: '/etc',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.worktreePath).not.toBe('/etc');
    });
  });

  // ── PATCH /api/threads/:id/status ──────────────────────

  describe('PATCH /api/threads/:id/status', () => {
    test('updates a valid status value', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/status', {
        value: 'running',
        reason: 'scheduler-dispatch',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('running');
    });

    test('rejects an invalid status with 400', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/status', {
        value: 'not-a-status',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid status/);
    });

    test('returns 400 when value is missing', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/status', {
        reason: 'no value',
      });
      expect(res.status).toBe(400);
    });

    test('returns 404 for someone else’s thread (cross-tenant guard)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/status', {
        value: 'running',
      });
      expect(res.status).toBe(404);
    });
  });

  // ── PATCH /api/threads/:id/stage ───────────────────────

  describe('PATCH /api/threads/:id/stage', () => {
    test('updates a valid stage value', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/stage', {
        value: 'review',
        reason: 'agent-completed',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stage).toBe('review');
    });

    test('rejects an invalid stage with 400', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/stage', {
        value: 'shipped',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid stage/);
    });

    test('returns 404 for non-existent thread', async () => {
      const res = await t.requestAs('user-1').patch('/api/threads/missing/stage', {
        value: 'in_progress',
      });
      expect(res.status).toBe(404);
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
      // Enriched with an author field (null when no user row is seeded).
      expect('user' in body).toBe(true);
      // Broadcasts a `thread:comment` to the thread's viewers for live append.
      const broadcast = threadViewerCalls.at(-1);
      expect(broadcast?.threadId).toBe('t1');
      expect(broadcast?.event.type).toBe('thread:comment');
      expect((broadcast?.event.comment as any)?.id).toBe(body.id);
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

      // Broadcasts a `thread:comment_deleted` with the id so viewers drop it live.
      const broadcast = threadViewerCalls.at(-1);
      expect(broadcast?.event.type).toBe('thread:comment_deleted');
      expect(broadcast?.event.commentId).toBe(id);

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

    test('returns 404 when caller does not own the thread (C1 IDOR)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't1', content: 'Theirs' });

      const res = await t.requestAs('user-2').delete('/api/threads/t1/queue/q1');
      expect(res.status).toBe(404);

      // Verify the queued message was NOT cancelled.
      const list = await t.requestAs('user-1').get('/api/threads/t1/queue');
      const body = await list.json();
      expect(body).toHaveLength(1);
    });

    test('does not cancel when messageId belongs to a different thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't2', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't2', content: 'In t2' });

      const res = await t.requestAs('user-1').delete('/api/threads/t1/queue/q1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);

      // q1 still exists in t2.
      const list = await t.requestAs('user-1').get('/api/threads/t2/queue');
      const lbody = await list.json();
      expect(lbody).toHaveLength(1);
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

    test('returns 404 when caller does not own the thread (C1 IDOR)', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't1', content: 'Theirs' });

      const res = await t.requestAs('user-2').patch('/api/threads/t1/queue/q1', {
        content: 'pwned',
      });
      expect(res.status).toBe(404);

      const list = await t.requestAs('user-1').get('/api/threads/t1/queue');
      const body = await list.json();
      expect(body[0].content).toBe('Theirs');
    });

    test('does not update when messageId belongs to a different thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't2', projectId: 'p1', userId: 'user-1' });
      seedMessageQueue(t.db as any, { id: 'q1', threadId: 't2', content: 'In t2' });

      const res = await t.requestAs('user-1').patch('/api/threads/t1/queue/q1', {
        content: 'pwned',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);

      const list = await t.requestAs('user-1').get('/api/threads/t2/queue');
      const lbody = await list.json();
      expect(lbody[0].content).toBe('In t2');
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

    test('does not return other users threads', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });
      seedMessage(t.db as any, {
        id: 'msg1',
        threadId: 't1',
        content: 'secret brown fox content',
      });

      const res = await t.requestAs('user-1').get('/api/threads/search/content?q=brown+fox');
      expect(res.status).toBe(200);
      expect((await res.json()).threadIds).toEqual([]);
    });
  });

  describe('GET /api/threads/scratch', () => {
    test('returns only the caller scratch threads', async () => {
      seedThread(t.db as any, {
        id: 's1',
        userId: 'user-1',
        isScratch: 1,
        projectId: null as any,
        title: 'My scratch',
      });
      seedThread(t.db as any, {
        id: 's2',
        userId: 'user-2',
        isScratch: 1,
        projectId: null as any,
        title: 'Their scratch',
      });

      const res = await t.requestAs('user-1').get('/api/threads/scratch');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].id).toBe('s1');
    });
  });

  describe('GET /api/threads/archived', () => {
    test('lists archived threads for the caller', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        title: 'Old work',
        archived: 1,
      });
      seedThread(t.db as any, {
        id: 't2',
        projectId: 'p1',
        userId: 'user-1',
        title: 'Active',
        archived: 0,
      });

      const res = await t.requestAs('user-1').get('/api/threads/archived');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].id).toBe('t1');
    });
  });

  describe('GET /api/threads/:id/messages', () => {
    test('returns paginated messages for the owner', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessage(t.db as any, { id: 'm1', threadId: 't1', content: 'One' });
      seedMessage(t.db as any, { id: 'm2', threadId: 't1', content: 'Two' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/messages');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toHaveLength(2);
    });

    test('returns 404 for cross-tenant access', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/messages');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/threads/:id/messages/search', () => {
    test('searches within a thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessage(t.db as any, {
        id: 'm1',
        threadId: 't1',
        content: 'findme needle',
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1/messages/search?q=findme');
      expect(res.status).toBe(200);
      expect((await res.json()).results).toHaveLength(1);
    });

    test('returns empty results for blank query', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/messages/search?q=');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    });
  });

  describe('GET /api/threads/:id/events', () => {
    test('returns persisted thread events for the owner', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThreadEvent(t.db as any, {
        id: 'ev-1',
        threadId: 't1',
        eventType: 'workflow:step',
        data: '{"step":"review"}',
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1/events');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events).toHaveLength(1);
      expect(body.events[0].type).toBe('workflow:step');
    });

    test('returns 404 for cross-tenant access', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/events');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/threads/:id/touched-files', () => {
    test('returns unique file paths from Write/Edit tool calls', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessage(t.db as any, { id: 'm1', threadId: 't1' });
      seedToolCall(t.db as any, {
        id: 'tc1',
        messageId: 'm1',
        name: 'Write',
        input: JSON.stringify({ file_path: 'src/a.ts' }),
      });
      seedToolCall(t.db as any, {
        id: 'tc2',
        messageId: 'm1',
        name: 'Edit',
        input: JSON.stringify({ file_path: 'src/b.ts' }),
      });

      const res = await t.requestAs('user-1').get('/api/threads/t1/touched-files');
      expect(res.status).toBe(200);
      expect((await res.json()).files).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });

  describe('POST /api/threads/:id/scheduler/workflow-event', () => {
    test('relays workflow events to the authenticated user', async () => {
      const res = await t.requestAs('user-1').post('/api/threads/t-any/scheduler/workflow-event', {
        event: 'workflow:step',
        data: { step: 1 },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(relayCalls).toHaveLength(1);
      expect(relayCalls[0]?.userId).toBe('user-1');
      expect(relayCalls[0]?.event).toMatchObject({
        type: 'workflow:step',
        threadId: 't-any',
        data: { step: 1 },
      });
    });

    test('rejects events that do not start with workflow:', async () => {
      const res = await t.requestAs('user-1').post('/api/threads/t-any/scheduler/workflow-event', {
        event: 'agent:result',
      });
      expect(res.status).toBe(400);
      expect(relayCalls).toHaveLength(0);
    });
  });

  describe('POST /api/threads/:id/workflow-event', () => {
    test('persists and acknowledges a workflow event', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/workflow-event', {
        type: 'workflow:notify',
        data: { message: 'Step done' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.eventId).toBeTruthy();

      const events = await t.requestAs('user-1').get('/api/threads/t1/events');
      expect((await events.json()).events).toHaveLength(1);
    });

    test('rejects non-workflow event types', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/workflow-event', {
        type: 'agent:result',
      });
      expect(res.status).toBe(400);
    });

    test('returns 404 for cross-tenant post', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/workflow-event', {
        type: 'workflow:notify',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/threads/:id/comments — tenant isolation', () => {
    test('returns 404 for cross-tenant comment list', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').get('/api/threads/t1/comments');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/threads/:id/stage — history', () => {
    test('records stage history on valid transition', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-history',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'backlog',
      });

      const res = await t
        .requestAs('user-1')
        .patch('/api/threads/t-history/stage', { value: 'in_progress' });
      expect(res.status).toBe(200);

      const rows = await t.db
        .select()
        .from(t.schema.stageHistory)
        .where(eq(t.schema.stageHistory.threadId, 't-history'));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.fromStage === 'backlog' && r.toStage === 'in_progress')).toBe(true);
    });
  });

  // The Kanban board sends stage moves and archive/unarchive through the
  // generic PATCH /:id route. It must record the movement trail and broadcast
  // thread:stage-changed so every tab updates live (regression: drags used to
  // be silent — no history, no cross-tab sync — and the card "bounced" back).
  describe('PATCH /api/threads/:id — stage movement trail + events', () => {
    function stageEvents() {
      return relayCalls.filter((c) => c.event.type === 'thread:stage-changed');
    }

    test('records history and emits thread:stage-changed on a drag stage move', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-move',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'backlog',
      });

      const res = await t
        .requestAs('user-1')
        .patch('/api/threads/t-move', { stage: 'in_progress' });
      expect(res.status).toBe(200);

      const rows = await t.db
        .select()
        .from(t.schema.stageHistory)
        .where(eq(t.schema.stageHistory.threadId, 't-move'));
      expect(rows.some((r) => r.fromStage === 'backlog' && r.toStage === 'in_progress')).toBe(true);

      const events = stageEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        userId: 'user-1',
        event: {
          type: 'thread:stage-changed',
          threadId: 't-move',
          data: { fromStage: 'backlog', toStage: 'in_progress', projectId: 'p1' },
        },
      });
    });

    test('archiving emits a transition to "archived" and records it', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-arch',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'review',
        archived: 0,
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t-arch', { archived: true });
      expect(res.status).toBe(200);

      const rows = await t.db
        .select()
        .from(t.schema.stageHistory)
        .where(eq(t.schema.stageHistory.threadId, 't-arch'));
      expect(rows.some((r) => r.fromStage === 'review' && r.toStage === 'archived')).toBe(true);

      const events = stageEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.event.data).toMatchObject({
        fromStage: 'review',
        toStage: 'archived',
        projectId: 'p1',
      });
    });

    test('unarchiving emits a transition back from "archived"', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-unarch',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'review',
        archived: 1,
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t-unarch', { archived: false });
      expect(res.status).toBe(200);

      const events = stageEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.event.data).toMatchObject({
        fromStage: 'archived',
        toStage: 'review',
        projectId: 'p1',
      });
    });

    test('a no-op stage PATCH (same stage) records nothing and emits nothing', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-same',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'backlog',
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t-same', { stage: 'backlog' });
      expect(res.status).toBe(200);

      const rows = await t.db
        .select()
        .from(t.schema.stageHistory)
        .where(eq(t.schema.stageHistory.threadId, 't-same'));
      expect(rows).toHaveLength(0);
      expect(stageEvents()).toHaveLength(0);
    });

    test('a non-stage PATCH (title only) emits no stage event', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, {
        id: 't-title',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'backlog',
      });

      const res = await t.requestAs('user-1').patch('/api/threads/t-title', { title: 'Renamed' });
      expect(res.status).toBe(200);
      expect(stageEvents()).toHaveLength(0);
    });
  });
});
