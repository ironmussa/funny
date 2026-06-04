/**
 * Integration tests for authMiddleware — public paths, sessions, runner invite
 * tokens, orchestrator auth, and requirePermission.
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'auth-mw-secret';
process.env.ORCHESTRATOR_AUTH_SECRET = 'orch-mw-secret';

import {
  authMockState,
  createAuthApiMock,
  resetAuthMiddlewareCache,
} from '../helpers/auth-mock.js';

const sessionUserId = 'session-user-1';

mock.module('../../lib/auth.js', () => ({
  auth: {
    api: createAuthApiMock({
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? '';
        if (cookie.includes('funny.session=valid')) {
          return {
            user: { id: sessionUserId, role: 'user' },
            session: { activeOrganizationId: 'org-acme' },
          };
        }
        if (cookie.includes('funny.session=badrole')) {
          return {
            user: { id: sessionUserId, role: 'superadmin' },
            session: { activeOrganizationId: 'org-acme' },
          };
        }
        return null;
      },
    }),
  },
}));

mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import {
  authMiddleware,
  requirePermission,
  resetAuthInstanceForTests,
} from '../../middleware/auth.js';
import { inviteLinkPublicRoutes } from '../../routes/invite-links.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedInviteLink, seedRunner } from '../helpers/test-db.js';

function protectedApp() {
  const app = new Hono<ServerEnv>();
  app.use('*', authMiddleware);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/protected', (c) =>
    c.json({
      userId: c.get('userId') ?? null,
      isRunner: c.get('isRunner') ?? false,
      runnerId: c.get('runnerId') ?? null,
      userRole: c.get('userRole') ?? null,
    }),
  );
  app.post('/api/runners/register', (c) =>
    c.json({ userId: c.get('userId') ?? null, isRunner: c.get('isRunner') ?? false }),
  );
  app.route('/api/invite-links', inviteLinkPublicRoutes);
  app.get('/api/orchestrator/system/ping', (c) =>
    c.json({
      isOrchestratorSystem: c.get('isOrchestratorSystem') ?? false,
      userId: c.get('userId') ?? null,
    }),
  );
  app.put('/api/permission-gated', requirePermission('member', 'update'), (c) =>
    c.json({ ok: true }),
  );
  return app;
}

describe('authMiddleware (integration)', () => {
  let t: TestApp;
  let app: Hono<ServerEnv>;
  let ps: typeof import('../../services/profile-service.js');

  beforeAll(async () => {
    t = await createTestApp();
    app = protectedApp();
    ps = await import('../../services/profile-service.js');
  });

  beforeEach(async () => {
    t.cleanup();
    authMockState.hasPermission = true;
    authMockState.permissionCheckThrows = false;
    resetAuthInstanceForTests();
    await resetAuthMiddlewareCache();
  });

  test('allows public /api/health without credentials', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('allows public invite verify without credentials', async () => {
    seedInviteLink(t.db as any, { token: 'public-token', organizationId: 'org-acme' });

    const res = await app.request('/api/invite-links/verify/public-token');
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
  });

  test('rejects protected routes without a valid session', async () => {
    const res = await app.request('/api/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('accepts protected routes with a valid session cookie', async () => {
    const res = await app.request('/api/protected', {
      headers: { cookie: 'funny.session=valid' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: sessionUserId,
      isRunner: false,
      runnerId: null,
      userRole: 'user',
    });
  });

  test('accepts Bearer runner_ token and sets isRunner', async () => {
    seedRunner(t.db as any, { id: 'r-bearer', token: 'runner_bearer_ok', userId: 'user-1' });

    const res = await app.request('/api/protected', {
      headers: { Authorization: 'Bearer runner_bearer_ok' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: null,
      isRunner: true,
      runnerId: 'r-bearer',
      userRole: null,
    });
  });

  test('rejects invalid Bearer runner_ token', async () => {
    const res = await app.request('/api/protected', {
      headers: { Authorization: 'Bearer runner_unknown' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid runner token' });
  });

  test('coerces unknown session roles to user', async () => {
    const res = await app.request('/api/protected', {
      headers: { cookie: 'funny.session=badrole' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: sessionUserId,
      userRole: 'user',
      isRunner: false,
    });
  });

  test('accepts runner registration with a valid invite token', async () => {
    const token = await ps.getOrCreateRunnerInviteToken('invite-user');

    const res = await app.request('/api/runners/register', {
      method: 'POST',
      headers: { 'X-Runner-Invite-Token': token },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'invite-user', isRunner: false });
  });

  test('rejects runner registration with an invalid invite token', async () => {
    const res = await app.request('/api/runners/register', {
      method: 'POST',
      headers: { 'X-Runner-Invite-Token': 'utkn_invalid' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid runner invite token' });
  });

  test('requirePermission returns 403 when permission is denied', async () => {
    authMockState.hasPermission = false;

    const res = await app.request('/api/permission-gated', {
      method: 'PUT',
      headers: {
        cookie: 'funny.session=valid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test('requirePermission passes when permission is granted', async () => {
    const res = await app.request('/api/permission-gated', {
      method: 'PUT',
      headers: {
        cookie: 'funny.session=valid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('rejects shared-secret runner registration from non-loopback', async () => {
    const res = await app.request(
      '/api/runners/register',
      {
        method: 'POST',
        headers: { 'X-Runner-Auth': 'auth-mw-secret' },
      },
      { IP: { address: '10.0.0.1' } },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/X-Runner-Invite-Token/);
  });

  test('orchestrator auth with X-Forwarded-User impersonates that user', async () => {
    const res = await app.request('/api/protected', {
      headers: {
        'X-Orchestrator-Auth': 'orch-mw-secret',
        'X-Forwarded-User': 'user-impersonated',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: 'user-impersonated',
      isRunner: false,
    });
  });

  test('requirePermission returns 403 when permission check throws', async () => {
    authMockState.permissionCheckThrows = true;

    const res = await app.request('/api/permission-gated', {
      method: 'PUT',
      headers: {
        cookie: 'funny.session=valid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: permission check failed' });
  });

  test('orchestrator system auth sets isOrchestratorSystem without forwarded user', async () => {
    const res = await app.request('/api/orchestrator/system/ping', {
      headers: { 'X-Orchestrator-Auth': 'orch-mw-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isOrchestratorSystem: true, userId: null });
  });

  test('orchestrator auth without forwarded user is rejected on non-system paths', async () => {
    const res = await app.request('/api/protected', {
      headers: { 'X-Orchestrator-Auth': 'orch-mw-secret' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'X-Forwarded-User required with orchestrator auth' });
  });
});
