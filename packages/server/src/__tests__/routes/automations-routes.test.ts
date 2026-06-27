/**
 * Integration tests for /api/automations CRUD + tenant isolation.
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
  relayToThreadViewers: () => {},
  evictUserFromThread: () => {},
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
import { seedAutomation, seedAutomationRun, seedProject, seedThread } from '../helpers/test-db.js';

describe('Automations Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedProject(t.db as any, { id: 'p2', userId: 'user-2', path: '/tmp/p2' });
  });

  describe('GET /api/automations', () => {
    test('returns only the caller’s automations', async () => {
      seedAutomation(t.db as any, {
        id: 'a1',
        projectId: 'p1',
        userId: 'user-1',
        name: 'Alice Job',
      });
      seedAutomation(t.db as any, {
        id: 'a2',
        projectId: 'p2',
        userId: 'user-2',
        name: 'Bob Job',
      });

      const res = await t.requestAs('user-1').get('/api/automations');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('a1');
    });

    test('filters by projectId', async () => {
      seedProject(t.db as any, { id: 'p1b', userId: 'user-1', path: '/tmp/p1b' });
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedAutomation(t.db as any, { id: 'a2', projectId: 'p1b', userId: 'user-1' });

      const res = await t.requestAs('user-1').get('/api/automations?projectId=p1');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('a1');
    });
  });

  describe('GET /api/automations/:id', () => {
    test('returns 404 for cross-tenant access', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-2').get('/api/automations/a1');
      expect(res.status).toBe(404);
    });

    test('returns the automation for the owner', async () => {
      seedAutomation(t.db as any, {
        id: 'a1',
        projectId: 'p1',
        userId: 'user-1',
        name: 'Owner Job',
      });

      const res = await t.requestAs('user-1').get('/api/automations/a1');
      expect(res.status).toBe(200);
      expect((await res.json()).name).toBe('Owner Job');
    });
  });

  describe('POST /api/automations', () => {
    test('creates an automation for the authenticated user', async () => {
      const res = await t.requestAs('user-1').post('/api/automations', {
        projectId: 'p1',
        name: 'New Job',
        prompt: 'Do the thing',
        schedule: '0 8 * * *',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('New Job');
      expect(body.userId).toBe('user-1');
      expect(body.projectId).toBe('p1');
    });

    test('returns 400 when required fields are missing', async () => {
      const res = await t.requestAs('user-1').post('/api/automations', {
        projectId: 'p1',
        name: 'Incomplete',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/automations/:id', () => {
    test('updates the owner’s automation', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1', enabled: 1 });

      const res = await t.requestAs('user-1').patch('/api/automations/a1', {
        name: 'Renamed',
        enabled: false,
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.name).toBe('Renamed');
      expect(body.enabled).toBe(0);
    });

    test('returns 404 for cross-tenant patch', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-2').patch('/api/automations/a1', { name: 'Hijacked' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/automations/:id', () => {
    test('deletes the owner’s automation', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

      const del = await t.requestAs('user-1').delete('/api/automations/a1');
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });

      const get = await t.requestAs('user-1').get('/api/automations/a1');
      expect(get.status).toBe(404);
    });

    test('returns 404 for cross-tenant delete', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

      const res = await t.requestAs('user-2').delete('/api/automations/a1');
      expect(res.status).toBe(404);

      const ownerCheck = await t.requestAs('user-1').get('/api/automations/a1');
      expect(ownerCheck.status).toBe(200);
    });
  });

  describe('GET /api/automations/inbox', () => {
    test('returns completed/failed runs for the caller with filters', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedAutomation(t.db as any, { id: 'a2', projectId: 'p2', userId: 'user-2' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't2', projectId: 'p2', userId: 'user-2' });
      seedAutomationRun(t.db as any, {
        id: 'r1',
        automationId: 'a1',
        threadId: 't1',
        status: 'completed',
        triageStatus: 'pending',
      });
      seedAutomationRun(t.db as any, {
        id: 'r2',
        automationId: 'a2',
        threadId: 't2',
        status: 'completed',
        triageStatus: 'pending',
      });
      seedAutomationRun(t.db as any, {
        id: 'r3',
        automationId: 'a1',
        threadId: 't1',
        status: 'running',
        triageStatus: 'pending',
      });

      const res = await t
        .requestAs('user-1')
        .get('/api/automations/inbox?projectId=p1&triageStatus=pending');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].run.id).toBe('r1');
      expect(body[0].automation.id).toBe('a1');
    });
  });

  describe('GET /api/automations/:id/runs', () => {
    test('returns runs for the owner only', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedAutomationRun(t.db as any, {
        id: 'r1',
        automationId: 'a1',
        threadId: 't1',
        status: 'completed',
      });

      const owner = await t.requestAs('user-1').get('/api/automations/a1/runs');
      expect(owner.status).toBe(200);
      expect(await owner.json()).toHaveLength(1);

      const other = await t.requestAs('user-2').get('/api/automations/a1/runs');
      expect(other.status).toBe(404);
    });
  });

  describe('PATCH /api/automations/runs/:runId/triage', () => {
    test('updates triage status for the owner', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedAutomationRun(t.db as any, {
        id: 'r1',
        automationId: 'a1',
        threadId: 't1',
        triageStatus: 'pending',
      });

      const res = await t
        .requestAs('user-1')
        .patch('/api/automations/runs/r1/triage', { triageStatus: 'reviewed' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test('returns 404 for cross-tenant triage update', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedAutomationRun(t.db as any, { id: 'r1', automationId: 'a1', threadId: 't1' });

      const res = await t
        .requestAs('user-2')
        .patch('/api/automations/runs/r1/triage', { triageStatus: 'reviewed' });
      expect(res.status).toBe(404);
    });

    test('returns 400 when triageStatus is missing', async () => {
      const res = await t.requestAs('user-1').patch('/api/automations/runs/r1/triage', {});
      expect(res.status).toBe(400);
    });
  });
});
