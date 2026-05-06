/**
 * Integration tests for runner routes.
 *
 * Tests registration, listing, deletion, and project assignment
 * against an in-memory SQLite database with real route handlers.
 */

import { mock } from 'bun:test';

// Set env before module imports
process.env.RUNNER_AUTH_SECRET = 'test-secret';

// Mock WebSocket modules
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
  TunnelTimeoutError: class TunnelTimeoutError extends Error {},
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedRunner, seedProject, seedRunnerProjectAssignment } from '../helpers/test-db.js';

describe('Runner Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
  });

  // ── POST /api/runners/register ─────────────────────────

  describe('POST /api/runners/register', () => {
    test('registers a new runner (201)', async () => {
      const res = await t.requestAs('user-1').post('/api/runners/register', {
        name: 'My Laptop',
        hostname: 'laptop.local',
        os: 'darwin',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.runnerId).toBeTruthy();
      expect(body.token).toMatch(/^runner_/);
    });

    test('reuses existing runner with same hostname', async () => {
      // Register first time
      const res1 = await t.requestAs('user-1').post('/api/runners/register', {
        name: 'Laptop',
        hostname: 'laptop.local',
        os: 'darwin',
      });
      const body1 = await res1.json();

      // Register again — should reuse
      const res2 = await t.requestAs('user-1').post('/api/runners/register', {
        name: 'Laptop Updated',
        hostname: 'laptop.local',
        os: 'darwin',
      });
      const body2 = await res2.json();

      expect(body2.runnerId).toBe(body1.runnerId);
      expect(body2.token).toBe(body1.token);
    });

    test('returns 400 when required fields are missing', async () => {
      const res = await t.requestAs('user-1').post('/api/runners/register', {
        name: 'Incomplete',
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/runners ───────────────────────────────────

  describe('GET /api/runners', () => {
    test('admin sees all runners', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });
      seedRunner(t.db as any, { id: 'r2', userId: 'user-2', name: 'R2', token: 'tok-2' });

      const res = await t.requestAs('admin-user', 'admin').get('/api/runners');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runners).toHaveLength(2);
    });

    test('regular user sees only their own runners', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });
      seedRunner(t.db as any, { id: 'r2', userId: 'user-2', name: 'R2', token: 'tok-2' });

      const res = await t.requestAs('user-1').get('/api/runners');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runners).toHaveLength(1);
      expect(body.runners[0].name).toBe('R1');
    });
  });

  // ── GET /api/runners/:runnerId ─────────────────────────

  describe('GET /api/runners/:runnerId', () => {
    test('returns runner details', async () => {
      seedRunner(t.db as any, {
        id: 'r1',
        userId: 'user-1',
        name: 'My Runner',
        token: 'tok-1',
        hostname: 'dev.local',
      });

      const res = await t.requestAs('user-1').get('/api/runners/r1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('My Runner');
      expect(body.hostname).toBe('dev.local');
    });

    test('returns 404 for non-existent runner', async () => {
      const res = await t.requestAs('user-1').get('/api/runners/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/runners/:runnerId ──────────────────────

  describe('DELETE /api/runners/:runnerId', () => {
    test('admin can delete any runner', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });

      const res = await t.requestAs('admin-user', 'admin').delete('/api/runners/r1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify runner is gone
      const getRes = await t.requestAs('admin-user', 'admin').get('/api/runners/r1');
      expect(getRes.status).toBe(404);
    });

    test('user can delete their own runner', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });

      const res = await t.requestAs('user-1').delete('/api/runners/r1');
      expect(res.status).toBe(200);
    });

    test("user cannot delete another user's runner", async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });

      const res = await t.requestAs('user-2').delete('/api/runners/r1');
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/runners/:runnerId/projects ───────────────

  describe('POST /api/runners/:runnerId/projects', () => {
    test('assigns a project to a runner (201)', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/runners/r1/projects', {
        projectId: 'p1',
        localPath: '/home/user/project',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.projectId).toBe('p1');
      expect(body.localPath).toBe('/home/user/project');
    });

    test('returns 400 when required fields are missing', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });

      const res = await t.requestAs('user-1').post('/api/runners/r1/projects', {
        projectId: 'p1',
      });
      expect(res.status).toBe(400);
    });

    test('returns 404 when runner does not exist', async () => {
      const res = await t.requestAs('user-1').post('/api/runners/nonexistent/projects', {
        projectId: 'p1',
        localPath: '/home/user/project',
      });
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/runners/:runnerId/projects ────────────────

  describe('GET /api/runners/:runnerId/projects', () => {
    test('lists project assignments', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunnerProjectAssignment(t.db as any, {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/home/user/project',
      });

      const res = await t.requestAs('user-1').get('/api/runners/r1/projects');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0].localPath).toBe('/home/user/project');
    });

    test('returns 404 when runner does not exist', async () => {
      const res = await t.requestAs('user-1').get('/api/runners/nonexistent/projects');
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/runners/:runnerId/projects/:projectId ──

  describe('DELETE /api/runners/:runnerId/projects/:projectId', () => {
    test('unassigns project from runner', async () => {
      seedRunner(t.db as any, { id: 'r1', userId: 'user-1', name: 'R1', token: 'tok-1' });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
      seedRunnerProjectAssignment(t.db as any, {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/a',
      });

      const res = await t.requestAs('user-1').delete('/api/runners/r1/projects/p1');
      expect(res.status).toBe(200);

      // Verify assignment is removed
      const listRes = await t.requestAs('user-1').get('/api/runners/r1/projects');
      const body = await listRes.json();
      expect(body.assignments).toHaveLength(0);
    });
  });
});
