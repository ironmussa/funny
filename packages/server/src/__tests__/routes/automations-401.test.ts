/**
 * Security ME-5 — `GET /api/automations` previously made the tenant filter
 * conditional on `userId`. Auth middleware always populates userId today,
 * so the behaviour was safe in practice — but a future bypass that landed
 * here with `userId=undefined` (e.g. a misconfigured runner-auth path)
 * would have leaked every user's automations. The handler now refuses 401
 * when userId is missing, matching the `/inbox` and `/:id` siblings.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

mockCoreGitRepoChecks();

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

  test('every endpoint refuses 401 before validating or touching the DB', async () => {
    const requests: [string, string][] = [
      ['GET', '/api/automations/inbox'],
      ['GET', '/api/automations/a1'],
      ['POST', '/api/automations'],
      ['PATCH', '/api/automations/a1'],
      ['DELETE', '/api/automations/a1'],
      ['POST', '/api/automations/a1/trigger'],
      ['GET', '/api/automations/a1/runs'],
      ['PATCH', '/api/automations/runs/r1/triage'],
    ];
    for (const [method, path] of requests) {
      const res = await appWithUnauthed.app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
  });

  test('returns 200 when userId is set (regression: handler still works)', async () => {
    const res = await t.requestAs('user-1').get('/api/automations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
