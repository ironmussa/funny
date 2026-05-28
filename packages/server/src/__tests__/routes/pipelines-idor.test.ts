/**
 * Integration tests for pipeline IDOR (security CR-5).
 *
 * Before the fix, any authenticated user could read / patch / delete /
 * list pipelines belonging to any other user by guessing IDs. Repo
 * methods now require userId; route handlers thread it through; these
 * tests pin both ends of the contract.
 */
import { mock } from 'bun:test';

mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedPipeline, seedProject } from '../helpers/test-db.js';

describe('Pipeline IDOR (security CR-5)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // Mount the pipeline routes (not in default test-app helper).
    const { pipelineRoutes } = await import('../../routes/pipelines.js');
    (t.app as Hono<ServerEnv>).route('/api/pipelines', pipelineRoutes);
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', name: 'P1', userId: 'user-1', path: '/tmp/p1' });
    seedPipeline(t.db as any, {
      id: 'pipe-1',
      projectId: 'p1',
      userId: 'user-1',
      name: 'Alice Pipeline',
    });
  });

  test('user-2 GET /api/pipelines/:id (cross-tenant) returns 404', async () => {
    const res = await t.requestAs('user-2').get('/api/pipelines/pipe-1');
    expect(res.status).toBe(404);
  });

  test('user-1 GET /api/pipelines/:id (owner) returns the pipeline', async () => {
    const res = await t.requestAs('user-1').get('/api/pipelines/pipe-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Alice Pipeline');
  });

  test('user-2 GET /api/pipelines/project/p1 returns empty (cross-tenant filter)', async () => {
    const res = await t.requestAs('user-2').get('/api/pipelines/project/p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  test('user-2 PATCH /api/pipelines/:id (cross-tenant) returns 404 and does NOT mutate', async () => {
    const res = await t.requestAs('user-2').patch('/api/pipelines/pipe-1', { name: 'Hijacked' });
    expect(res.status).toBe(404);
    // Verify the row was not touched.
    const ownerCheck = await t.requestAs('user-1').get('/api/pipelines/pipe-1');
    const body = await ownerCheck.json();
    expect(body.name).toBe('Alice Pipeline');
  });

  test('user-2 DELETE /api/pipelines/:id (cross-tenant) returns 404 and does NOT delete', async () => {
    const res = await t.requestAs('user-2').delete('/api/pipelines/pipe-1');
    expect(res.status).toBe(404);
    const ownerCheck = await t.requestAs('user-1').get('/api/pipelines/pipe-1');
    expect(ownerCheck.status).toBe(200);
  });
});
