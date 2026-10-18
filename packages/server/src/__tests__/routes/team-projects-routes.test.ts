/**
 * Integration tests for /api/team-projects routes.
 */
import { afterAll, mock } from 'bun:test';

import * as realAuthModule from '../../lib/auth.js';
import { snapshotModule } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  authMockState,
  createAuthApiMock,
  resetAuthMiddlewareCache,
} from '../helpers/auth-mock.js';

// mock.module is process-global and never undone by mock.restore(); put the
// real module back once this file finishes so later files are unaffected.
const realAuth = snapshotModule(realAuthModule);
mock.module('../../lib/auth.js', () => ({
  auth: {
    api: createAuthApiMock(),
  },
}));
afterAll(() => {
  mock.module('../../lib/auth.js', () => realAuth);
});

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember, seedTeamProject } from '../helpers/test-db.js';

describe('Team Projects Routes (Integration)', () => {
  let t: TestApp;
  const orgId = 'org-acme';
  const userId = 'team-user-1';

  beforeAll(async () => {
    t = await createTestApp({ userId });
  });

  beforeEach(async () => {
    t.cleanup();
    authMockState.hasPermission = true;
    await resetAuthMiddlewareCache();
  });

  describe('GET /api/team-projects', () => {
    test('returns empty list when no active organization', async () => {
      const res = await t.requestAs(userId).get('/api/team-projects');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('returns projects linked to the active org with isTeamProject flag', async () => {
      seedProject(t.db as any, { id: 'p1', userId, name: 'Alpha', path: '/alpha' });
      seedProject(t.db as any, { id: 'p2', userId, name: 'Beta', path: '/beta' });
      seedTeamProject(t.db as any, { teamId: orgId, projectId: 'p1' });

      const res = await t.requestAs(userId, 'user', { orgId }).get('/api/team-projects');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('p1');
      expect(body[0].name).toBe('Alpha');
      expect(body[0].isTeamProject).toBe(true);
    });
  });

  describe('POST /api/team-projects', () => {
    test('returns 400 when no active organization', async () => {
      const res = await t.requestAs(userId).post('/api/team-projects', { projectId: 'p1' });
      expect(res.status).toBe(400);
    });

    test('returns 403 without project:create permission', async () => {
      authMockState.hasPermission = false;

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'p1' });
      expect(res.status).toBe(403);
    });

    test('returns 400 when projectId is missing', async () => {
      const res = await t.requestAs(userId, 'user', { orgId }).post('/api/team-projects', {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId is required' });
    });

    test('returns 404 when project does not exist', async () => {
      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'missing' });
      expect(res.status).toBe(404);
    });

    test('associates a project with the org', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/alpha' });

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ teamId: orgId, projectId: 'p1' });

      const list = await t.requestAs(userId, 'user', { orgId }).get('/api/team-projects');
      expect((await list.json())[0].id).toBe('p1');
    });

    test('returns 403 when linking a project the caller does not own (C3)', async () => {
      seedProject(t.db as any, { id: 'victim-p', userId: 'victim', path: '/victim' });

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'victim-p' });
      expect(res.status).toBe(403);

      const list = await t.requestAs(userId, 'user', { orgId }).get('/api/team-projects');
      expect(await list.json()).toEqual([]);
    });

    test('returns 403 when the caller is only a plain collaborator on the project', async () => {
      seedProject(t.db as any, { id: 'p-shared', userId: 'victim', path: '/shared' });
      seedProjectMember(t.db as any, { projectId: 'p-shared', userId, role: 'member' });

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'p-shared' });
      expect(res.status).toBe(403);
    });

    test('a project admin collaborator may link the project', async () => {
      seedProject(t.db as any, { id: 'p-admin', userId: 'someone', path: '/admin' });
      seedProjectMember(t.db as any, { projectId: 'p-admin', userId, role: 'admin' });

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'p-admin' });
      expect(res.status).toBe(201);
    });

    test('returns 409 when project is already associated', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/alpha' });
      seedTeamProject(t.db as any, { teamId: orgId, projectId: 'p1' });

      const res = await t
        .requestAs(userId, 'user', { orgId })
        .post('/api/team-projects', { projectId: 'p1' });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /api/team-projects/:projectId', () => {
    test('returns 400 when no active organization', async () => {
      const res = await t.requestAs(userId).delete('/api/team-projects/p1');
      expect(res.status).toBe(400);
    });

    test('returns 403 without project:delete permission', async () => {
      authMockState.hasPermission = false;

      const res = await t.requestAs(userId, 'user', { orgId }).delete('/api/team-projects/p1');
      expect(res.status).toBe(403);
    });

    test('removes the org association', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/alpha' });
      seedTeamProject(t.db as any, { teamId: orgId, projectId: 'p1' });

      const res = await t.requestAs(userId, 'user', { orgId }).delete('/api/team-projects/p1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const list = await t.requestAs(userId, 'user', { orgId }).get('/api/team-projects');
      expect(await list.json()).toEqual([]);
    });
  });
});
