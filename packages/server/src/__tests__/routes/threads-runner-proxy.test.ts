/**
 * Tests for server thread routes that proxy to runners (fork, delete cleanup).
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock, spyOn } from 'bun:test';

import * as wsRelay from '../../services/ws-relay.js';
import * as wsTunnel from '../../services/ws-tunnel.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

const tunnelFetch = mock<typeof wsTunnel.tunnelFetch>(async () => ({
  status: 201,
  headers: {},
  body: JSON.stringify({
    id: 't-forked',
    title: 'Forked thread',
    model: 'sonnet',
    mode: 'local',
    branch: 'feature/fork',
  }),
}));

import { eq } from 'drizzle-orm';

import * as runnerManager from '../../services/runner-manager.js';
import * as runnerResolver from '../../services/runner-resolver.js';
import * as threadRegistry from '../../services/thread-registry.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

describe('Thread routes — runner proxy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  const resolvedRunner = {
    runnerId: 'runner-1',
    httpUrl: 'http://runner.local',
  };

  beforeEach(() => {
    t.cleanup();
    spyOn(wsRelay, 'isRunnerConnected').mockReturnValue(true);
    spyOn(wsTunnel, 'tunnelFetch').mockImplementation(tunnelFetch);
    spyOn(threadRegistry, 'registerThread').mockResolvedValue(undefined);
    spyOn(runnerManager, 'findRunnerForProject').mockResolvedValue({
      runner: { runnerId: 'runner-1', httpUrl: 'http://runner.local' },
    } as any);
    spyOn(runnerManager, 'findAnyRunnerForUser').mockResolvedValue(null);
    spyOn(runnerResolver, 'resolveRunner').mockResolvedValue(resolvedRunner as any);
    (threadRegistry.registerThread as ReturnType<typeof mock>).mockClear();
    tunnelFetch.mockClear();
    tunnelFetch.mockImplementation(async () => ({
      status: 201,
      headers: {},
      body: JSON.stringify({
        id: 't-forked',
        title: 'Forked thread',
        model: 'sonnet',
        mode: 'local',
        branch: 'feature/fork',
      }),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  describe('POST /api/threads', () => {
    test('creates a project thread on the runner and registers it locally', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'New thread',
        prompt: 'Hello',
        model: 'sonnet',
        mode: 'local',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-forked');
      expect(tunnelFetch).toHaveBeenCalled();
      expect(threadRegistry.registerThread).toHaveBeenCalled();
    });

    test('returns 400 when projectId is missing for a normal thread', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        title: 'No project',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('returns 400 when scratch thread includes a projectId', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        projectId: 'p1',
        title: 'Bad scratch',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('scratch-thread-cannot-have-project');
    });

    test('returns 400 when scratch thread uses non-local mode', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        mode: 'worktree',
        title: 'Bad scratch',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('scratch-thread-must-be-local');
    });

    test('creates a scratch thread via any user runner', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 201,
        headers: {},
        body: JSON.stringify({
          id: 't-scratch-new',
          title: 'Scratch pad',
          model: 'sonnet',
          mode: 'local',
        }),
      }));

      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        title: 'Scratch pad',
        prompt: 'Try regex',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-scratch-new');
      expect(runnerResolver.resolveRunner).toHaveBeenCalled();
    });

    test('returns 502 when no runner is available', async () => {
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      (runnerResolver.resolveRunner as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'No runner',
        prompt: 'Hi',
      });
      expect(res.status).toBe(502);
    });

    test('forwards runner error status when tunnel responds with failure', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 422,
        headers: {},
        body: JSON.stringify({ error: 'invalid prompt' }),
      }));
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'Bad',
        prompt: 'Hi',
      });
      expect(res.status).toBe(422);
      expect(threadRegistry.registerThread).not.toHaveBeenCalled();
    });

    test('POST /api/threads/idle proxies to the idle runner path', async () => {
      let capturedPath = '';
      tunnelFetch.mockImplementationOnce(async (_runnerId, req) => {
        capturedPath = req.path;
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({ id: 't-idle', title: 'Idle', model: 'sonnet', mode: 'local' }),
        };
      });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads/idle', {
        projectId: 'p1',
        title: 'Idle thread',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-idle');
      expect(capturedPath).toBe('/api/threads/idle');
    });
  });

  describe('POST /api/threads/:id/fork', () => {
    test('proxies fork to runner and returns new thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Source' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('t-forked');
      expect(tunnelFetch).toHaveBeenCalled();
    });

    test('returns 404 for cross-tenant fork', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(404);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('returns 502 when no runner is available', async () => {
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      spyOn(runnerResolver, 'resolveRunner').mockResolvedValueOnce(null);

      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(502);
    });

    test('preserves runner error messages', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 400,
        headers: {},
        body: JSON.stringify({ error: 'Rewind is only available for Claude threads' }),
      }));
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        messageId: 'm-anchor',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Rewind is only available for Claude threads' });
    });
  });

  describe('DELETE /api/threads/:id — tenant isolation', () => {
    test('returns 404 when deleting another user thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').delete('/api/threads/t1');
      expect(res.status).toBe(404);

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't1'))
        .get();
      expect(row).toBeTruthy();
    });
  });
});
