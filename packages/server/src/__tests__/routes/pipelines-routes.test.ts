/**
 * Integration tests for /api/pipelines CRUD happy paths.
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

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

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedPipeline, seedPipelineRun, seedProject, seedThread } from '../helpers/test-db.js';

describe('Pipeline Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
  });

  describe('POST /api/pipelines', () => {
    test('creates a pipeline for the authenticated user', async () => {
      const res = await t.requestAs('user-1').post('/api/pipelines', {
        projectId: 'p1',
        name: 'Review Pipeline',
        maxIterations: 5,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Review Pipeline');
      expect(body.userId).toBe('user-1');
      expect(body.projectId).toBe('p1');
      expect(body.maxIterations).toBe(5);
    });

    test('returns 400 when required fields are missing', async () => {
      const res = await t.requestAs('user-1').post('/api/pipelines', { name: 'No Project' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId and name are required' });
    });
  });

  describe('GET /api/pipelines/project/:projectId', () => {
    test('lists pipelines for the owner within a project', async () => {
      seedPipeline(t.db as any, { id: 'pipe-1', projectId: 'p1', userId: 'user-1', name: 'One' });
      seedPipeline(t.db as any, { id: 'pipe-2', projectId: 'p1', userId: 'user-1', name: 'Two' });

      const res = await t.requestAs('user-1').get('/api/pipelines/project/p1');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body.map((p: { id: string }) => p.id).sort()).toEqual(['pipe-1', 'pipe-2']);
    });
  });

  describe('PATCH /api/pipelines/:id', () => {
    test('updates pipeline fields for the owner', async () => {
      seedPipeline(t.db as any, {
        id: 'pipe-1',
        projectId: 'p1',
        userId: 'user-1',
        name: 'Before',
        enabled: 1,
      });

      const res = await t.requestAs('user-1').patch('/api/pipelines/pipe-1', {
        name: 'After',
        enabled: false,
        maxIterations: 3,
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.name).toBe('After');
      expect(body.enabled).toBe(0);
      expect(body.maxIterations).toBe(3);
    });

    test('returns 404 when pipeline is not found', async () => {
      const res = await t.requestAs('user-1').patch('/api/pipelines/missing', { name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/pipelines/:id', () => {
    test('deletes the owner’s pipeline', async () => {
      seedPipeline(t.db as any, { id: 'pipe-1', projectId: 'p1', userId: 'user-1' });

      const del = await t.requestAs('user-1').delete('/api/pipelines/pipe-1');
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });

      const get = await t.requestAs('user-1').get('/api/pipelines/pipe-1');
      expect(get.status).toBe(404);
    });
  });

  describe('GET /api/pipelines/runs/thread/:threadId', () => {
    test('returns runs scoped to the thread owner', async () => {
      seedPipeline(t.db as any, { id: 'pipe-1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedPipelineRun(t.db as any, {
        id: 'pr-1',
        pipelineId: 'pipe-1',
        threadId: 't1',
      });

      const res = await t.requestAs('user-1').get('/api/pipelines/runs/thread/t1');
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    });

    test('returns empty for cross-tenant thread lookup', async () => {
      seedPipeline(t.db as any, { id: 'pipe-1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedPipelineRun(t.db as any, {
        id: 'pr-1',
        pipelineId: 'pipe-1',
        threadId: 't1',
      });

      const res = await t.requestAs('user-2').get('/api/pipelines/runs/thread/t1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });
});
