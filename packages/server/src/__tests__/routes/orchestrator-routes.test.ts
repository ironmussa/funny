/**
 * Integration tests for /api/orchestrator routes.
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

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
  TunnelTimeoutError: class TunnelTimeoutError extends Error {
    name = 'TunnelTimeoutError';
  },
  isTunnelTimeoutError: () => false,
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { orchestratorRoutes } from '../../routes/orchestrator.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedOrchestratorRun, seedProject, seedThread } from '../helpers/test-db.js';

function unauthenticatedOrchestratorApp() {
  const app = new Hono<ServerEnv>();
  app.route('/api/orchestrator', orchestratorRoutes);
  return app;
}

describe('Orchestrator Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
  });

  describe('GET /api/orchestrator/runs', () => {
    test('returns 401 without a user context', async () => {
      const res = await unauthenticatedOrchestratorApp().request('/api/orchestrator/runs');
      expect(res.status).toBe(401);
    });

    test('returns only the caller’s active runs', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-a', path: '/a' });
      seedThread(t.db as any, { id: 't-a', projectId: 'p1', userId: 'user-a' });
      seedThread(t.db as any, { id: 't-b', projectId: 'p1', userId: 'user-b' });
      seedOrchestratorRun(t.db as any, { threadId: 't-a', userId: 'user-a' });
      seedOrchestratorRun(t.db as any, { threadId: 't-b', userId: 'user-b' });

      const res = await t.requestAs('user-a').get('/api/orchestrator/runs');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].threadId).toBe('t-a');
      expect(body.runs[0].userId).toBe('user-a');
    });
  });

  describe('POST /api/orchestrator/refresh', () => {
    test('returns deprecated no-op payload for authenticated callers', async () => {
      const res = await t.requestAs('user-a').post('/api/orchestrator/refresh');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toBeNull();
      expect(body.deprecated).toContain('no longer supported');
    });

    test('returns 401 without a user context', async () => {
      const res = await unauthenticatedOrchestratorApp().request('/api/orchestrator/refresh', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });
});
