/**
 * The `automations` tRPC procedures (openspec change adopt-trpc-browser-api):
 * mount, auth and CSRF behavior, tenant isolation, and parity with the REST
 * routes, which serve the same port while both paths coexist.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';

import type { ServerEnv } from '../../lib/types.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedAutomation, seedAutomationRun, seedProject, seedThread } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('automations tRPC procedures', () => {
  let t: TestApp;
  let proxied: string[];

  const query = async (userId: string, path: string, input?: unknown) => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/automations.${path}${qs}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/automations.${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
    // Stands in for the runner proxy catch-all, registered after every route.
    t.app.all('/api/*', (c) => {
      proxied.push(c.req.path);
      return c.json({ proxied: true }, 599 as never);
    });
  });

  beforeEach(() => {
    proxied = [];
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedProject(t.db as any, { id: 'p2', userId: 'user-2', path: '/tmp/p2' });
  });

  describe('mount', () => {
    test('an unknown procedure answers tRPC 404 and never reaches the runner proxy', async () => {
      const res = await t.app.request('/api/trpc/nope.missing', { headers: headersFor('user-1') });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.data.code).toBe('NOT_FOUND');
      expect(proxied).toEqual([]);
    });

    test('a request without a user is refused 401', async () => {
      const { mountTrpc } = await import('../../trpc/mount.js');
      const bare = new Hono<ServerEnv>();
      bare.use('*', async (c, next) => {
        c.set('organizationId', null);
        return next();
      });
      mountTrpc(bare);
      const res = await bare.request('/api/trpc/automations.list');
      expect(res.status).toBe(401);
    });

    test('a cross-origin form-style mutation is refused like REST', async () => {
      const { mountTrpc } = await import('../../trpc/mount.js');
      const app = new Hono<ServerEnv>();
      app.use('*', csrf({ origin: ['http://localhost:5173'] }));
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        c.set('organizationId', null);
        return next();
      });
      mountTrpc(app);
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
        const res = await app.request('/api/trpc/automations.remove', {
          method: 'POST',
          headers: { 'Content-Type': contentType, Origin: 'https://evil.example' },
          body: JSON.stringify({ id: 'a1' }),
        });
        expect(res.status).toBe(403);
      }
    });

    test('a mutation cannot be sent as GET', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      const res = await query('user-1', 'remove', { id: 'a1' });
      expect(res.status).toBe(405);
      expect((await query('user-1', 'get', { id: 'a1' })).status).toBe(200);
    });
  });

  describe('tenant isolation', () => {
    test('another user’s automation looks absent (404) on every procedure', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

      expect((await query('user-2', 'get', { id: 'a1' })).status).toBe(404);
      expect((await query('user-2', 'runs', { id: 'a1' })).status).toBe(404);
      expect((await mutate('user-2', 'update', { id: 'a1', data: { name: 'x' } })).status).toBe(
        404,
      );
      expect((await mutate('user-2', 'remove', { id: 'a1' })).status).toBe(404);
      expect((await mutate('user-2', 'trigger', { id: 'a1' })).status).toBe(404);
      expect((await query('user-1', 'get', { id: 'a1' })).status).toBe(200);
    });

    test('list returns only the caller’s automations', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      seedAutomation(t.db as any, { id: 'a2', projectId: 'p2', userId: 'user-2' });
      const res = await query('user-1', 'list');
      expect(res.body.result.data.map((a: any) => a.id)).toEqual(['a1']);
    });

    test('creating on a project the user cannot see answers 404', async () => {
      const res = await mutate('user-1', 'create', {
        projectId: 'p2',
        name: 'n',
        prompt: 'p',
        schedule: '0 * * * *',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Project not found');
    });
  });

  describe('validation', () => {
    test('invalid input answers 400 with the REST message', async () => {
      const res = await mutate('user-1', 'create', { projectId: 'p1', name: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(
        'Missing required fields: projectId, name, prompt, schedule',
      );
    });

    test('unknown update fields are rejected (strict allow-list)', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      const res = await mutate('user-1', 'update', { id: 'a1', data: { userId: 'user-2' } });
      expect(res.status).toBe(400);
    });
  });

  describe('happy paths', () => {
    test('create, update, triage and remove', async () => {
      const created = await mutate('user-1', 'create', {
        projectId: 'p1',
        name: 'Nightly',
        prompt: 'check',
        schedule: '0 3 * * *',
      });
      expect(created.status).toBe(200);
      const id = created.body.result.data.id;
      expect(created.body.result.data).toMatchObject({ name: 'Nightly', enabled: true });

      const updated = await mutate('user-1', 'update', { id, data: { enabled: false } });
      expect(updated.body.result.data.enabled).toBe(false);

      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedAutomationRun(t.db as any, {
        id: 'r1',
        automationId: id,
        threadId: 't1',
        status: 'completed',
      });
      expect(
        (await mutate('user-1', 'triageRun', { runId: 'r1', triageStatus: 'reviewed' })).body,
      ).toEqual({ result: { data: { ok: true } } });
      expect(
        (await mutate('user-2', 'triageRun', { runId: 'r1', triageStatus: 'reviewed' })).status,
      ).toBe(404);

      expect((await mutate('user-1', 'remove', { id })).body.result.data).toEqual({ ok: true });
      expect((await query('user-1', 'get', { id })).status).toBe(404);
    });
  });

  describe('parity with REST', () => {
    test('reads return the same data on both paths', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1', name: 'One' });
      seedAutomation(t.db as any, { id: 'a2', projectId: 'p1', userId: 'user-1', name: 'Two' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedAutomationRun(t.db as any, {
        id: 'r1',
        automationId: 'a1',
        threadId: 't1',
        status: 'completed',
      });

      const rest = t.requestAs('user-1');
      const pairs: Array<[string, string, unknown]> = [
        ['/api/automations', 'list', undefined],
        ['/api/automations?projectId=p1', 'list', { projectId: 'p1' }],
        ['/api/automations/a1', 'get', { id: 'a1' }],
        ['/api/automations/a1/runs', 'runs', { id: 'a1' }],
        ['/api/automations/inbox', 'inbox', undefined],
      ];
      for (const [restPath, procedure, input] of pairs) {
        const restRes = await rest.get(restPath);
        const trpcRes = await query('user-1', procedure, input);
        expect(trpcRes.status).toBe(restRes.status);
        expect(trpcRes.body.result.data).toEqual(await restRes.json());
      }
    });

    test('failures carry the same status and message on both paths', async () => {
      seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
      const restRes = await t.requestAs('user-2').get('/api/automations/a1');
      const trpcRes = await query('user-2', 'get', { id: 'a1' });
      expect(trpcRes.status).toBe(restRes.status);
      expect(trpcRes.body.error.message).toBe(((await restRes.json()) as any).error);
    });
  });
});
