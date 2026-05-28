/**
 * Security ME-5 — `GET /api/automations` previously made the tenant filter
 * conditional on `userId`. Auth middleware always populates userId today,
 * so the behaviour was safe in practice — but a future bypass that landed
 * here with `userId=undefined` (e.g. a misconfigured runner-auth path)
 * would have leaked every user's automations. The handler now refuses 401
 * when userId is missing, matching the `/inbox` and `/:id` siblings.
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

describe('GET /api/automations — userId required (security ME-5)', () => {
  let t: TestApp;
  let appWithUnauthed: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    const { automationRoutes } = await import('../../routes/automations.js');
    (t.app as Hono<ServerEnv>).route('/api/automations', automationRoutes);

    // A second app where the mock auth middleware leaves userId undefined,
    // to simulate the "bypass" scenario the ME-5 defense is supposed to
    // catch. We can't use the normal app's `requestAs` because it always
    // sets X-Test-User-Id.
    appWithUnauthed = await createTestApp();
    const bareApp = new Hono<ServerEnv>();
    bareApp.use('*', async (c, next) => {
      // Intentionally do NOT set userId.
      c.set('userRole', 'user');
      c.set('organizationId', null);
      return next();
    });
    bareApp.route('/api/automations', automationRoutes);
    appWithUnauthed.app = bareApp;
  });

  beforeEach(() => {
    t.cleanup();
  });

  test('refuses 401 when userId is missing', async () => {
    const res = await appWithUnauthed.app.request('/api/automations');
    expect(res.status).toBe(401);
  });

  test('returns 200 when userId is set (regression: handler still works)', async () => {
    const res = await t.requestAs('user-1').get('/api/automations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
