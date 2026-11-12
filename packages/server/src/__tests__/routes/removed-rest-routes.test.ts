/**
 * The REST routes the web client no longer calls (it uses tRPC, openspec
 * adopt-trpc-browser-api) were removed. Their paths must be REFUSED by the
 * server, never left to fall through to the runner proxy catch-all
 * (`app.all('/api/*', proxyToRunner)` in app.ts): the runtime answers some of
 * them itself (startup command CRUD under `/api/projects/:id/commands`), so a
 * project member's request would reach the owner's runner without the server's
 * `requireProjectAccess` check, and authorization would shift to the runner.
 *
 * The test app gets a sentinel catch-all in place of the proxy: a refused path
 * answers 404 from the server, a runner-answered path still reaches the
 * sentinel.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { REMOVED_PROJECT_ROUTES } from '../../routes/projects.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember, seedRunner } from '../helpers/test-db.js';

describe('removed REST routes are refused, not proxied', () => {
  let t: TestApp;
  const proxied: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    // Stands in for the runner proxy catch-all, mounted last like in app.ts.
    t.app.all('/api/*', (c) => {
      proxied.push(`${c.req.method} ${c.req.path}`);
      return c.json({ proxied: true }, 299 as any);
    });
  });

  beforeEach(() => {
    t.cleanup();
    proxied.length = 0;
    seedProject(t.db as any, { id: 'p1', userId: 'owner', path: '/tmp/p1' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'member', role: 'member' });
    seedRunner(t.db as any, { id: 'r1', userId: 'owner', token: 'tok-1', hostname: 'h' });
  });

  const send = (userId: string, method: string, path: string) =>
    t.app.request(path, {
      method,
      headers: { 'X-Test-User-Id': userId, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ label: 'x', command: 'id' }),
    });

  const concrete = (path: string) =>
    `/api/projects${path
      .replace(':id', 'p1')
      .replace(':cmdId', 'c1')
      .replace(':userId', 'member')
      .replace(':runnerId', 'r1')}`;

  describe('/api/projects', () => {
    for (const [method, path] of REMOVED_PROJECT_ROUTES) {
      test(`${method} ${path} → 404 for the owner and a member, nothing proxied`, async () => {
        for (const userId of ['owner', 'member']) {
          const res = await send(userId, method, concrete(path));
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: 'Not found' });
        }
        expect(proxied).toEqual([]);
      });
    }

    test('the runtime-answered startup command CRUD paths are among the refused ones', () => {
      const refused = REMOVED_PROJECT_ROUTES.map(([m, p]) => `${m} ${p}`);
      for (const route of [
        'GET /:id/commands',
        'POST /:id/commands',
        'PUT /:id/commands/:cmdId',
        'DELETE /:id/commands/:cmdId',
      ]) {
        expect(refused).toContain(route);
      }
    });

    test('runner-answered project paths still fall through to the runner', async () => {
      for (const [method, path] of [
        ['GET', '/api/projects/p1/branches'],
        ['GET', '/api/projects/p1/checkout-preflight'],
        ['POST', '/api/projects/p1/checkout'],
        ['GET', '/api/projects/p1/hooks'],
        ['PUT', '/api/projects/p1/hooks/reorder'],
        ['GET', '/api/projects/p1/config'],
        ['GET', '/api/projects/p1/weave/status'],
        ['POST', '/api/projects/p1/commands/c1/start'],
        ['POST', '/api/projects/p1/commands/c1/stop'],
        ['GET', '/api/projects/p1/commands/c1/status'],
      ] as const) {
        const res = await send('owner', method, path);
        expect(res.status).toBe(299);
      }
      expect(proxied).toHaveLength(10);
    });
  });

  describe('/api/runners (user branches)', () => {
    const removed = [
      ['GET', '/api/runners'],
      ['DELETE', '/api/runners/r1'],
      ['POST', '/api/runners/r1/projects'],
      ['GET', '/api/runners/r1/projects'],
      ['DELETE', '/api/runners/r1/projects/p1'],
      ['GET', '/api/runners/enroll/ABCD-EFGH'],
      ['POST', '/api/runners/enroll/approve'],
    ] as const;

    for (const [method, path] of removed) {
      test(`${method} ${path} → 404 for a user, nothing proxied`, async () => {
        for (const userId of ['owner', 'stranger']) {
          const res = await send(userId, method, path);
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: 'Not found' });
        }
        expect(proxied).toEqual([]);
      });
    }

    test('without a session they answer 401, nothing proxied', async () => {
      for (const [method, path] of removed) {
        expect((await send('', method, path)).status).toBe(401);
      }
      expect(proxied).toEqual([]);
    });
  });

  describe('/api/threads/archived', () => {
    test('answers 404 from the server (read as an unknown thread id), nothing proxied', async () => {
      const res = await send('owner', 'GET', '/api/threads/archived');
      expect(res.status).toBe(404);
      expect(proxied).toEqual([]);
    });
  });
});
