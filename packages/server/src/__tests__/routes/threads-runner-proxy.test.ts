/**
 * Tests for server thread routes that proxy to runners (fork, delete cleanup).
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => true,
  relayToUser: () => {},
  broadcast: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
}));

const tunnelFetch = mock(async () => ({
  status: 201,
  body: JSON.stringify({
    id: 't-forked',
    title: 'Forked thread',
    model: 'sonnet',
    mode: 'local',
    branch: 'feature/fork',
  }),
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch,
  TunnelTimeoutError: class TunnelTimeoutError extends Error {
    name = 'TunnelTimeoutError';
  },
  isTunnelTimeoutError: () => false,
}));

mock.module('../../services/runner-manager.js', () => ({
  findRunnerForProject: mock(async () => ({
    runner: { runnerId: 'runner-1', httpUrl: 'http://127.0.0.1:3003' },
  })),
  findAnyRunnerForUser: mock(async () => null),
}));

import { describe, test, expect, beforeAll, beforeEach, spyOn } from 'bun:test';

import { eq } from 'drizzle-orm';

import * as runnerResolver from '../../services/runner-resolver.js';
import * as threadRegistry from '../../services/thread-registry.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

describe('Thread routes — runner proxy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    spyOn(threadRegistry, 'registerThread').mockResolvedValue(undefined);
    tunnelFetch.mockClear();
    tunnelFetch.mockImplementation(async () => ({
      status: 201,
      body: JSON.stringify({
        id: 't-forked',
        title: 'Forked thread',
        model: 'sonnet',
        mode: 'local',
        branch: 'feature/fork',
      }),
    }));
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
      const runnerManager = await import('../../services/runner-manager.js');
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      spyOn(runnerResolver, 'resolveRunner').mockResolvedValueOnce(null);

      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(502);
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
