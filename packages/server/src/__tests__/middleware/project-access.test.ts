import { describe, expect, test } from 'bun:test';

import type { Role } from '@funny/shared/auth/roles';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProjectAccessMiddleware } from '../../middleware/project-access.js';

/** Roles by `${userId}|${projectId}`; anything absent has no access. */
const ROLES: Record<string, Role> = {
  'owner|p1': 'owner',
  'admin|p1': 'admin',
  'member|p1': 'contributor',
  'org-member|p1': 'viewer',
};

const requireProjectAccess = createProjectAccessMiddleware(
  async (userId, projectId) => ROLES[`${userId}|${projectId}`] ?? null,
);

function app() {
  const a = new Hono<ServerEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-User') ?? '');
    await next();
  });
  a.get('/projects/:id', requireProjectAccess('view'), (c) => c.json({ ok: true }));
  a.patch('/projects/:id', requireProjectAccess('manage', { forbidden: 'admins only' }), (c) =>
    c.json({ ok: true }),
  );
  a.get('/bindings/:projectId', requireProjectAccess('view', { param: 'projectId' }), (c) =>
    c.json({ ok: true }),
  );
  return a;
}

const as = (user: string, method: string, path: string) =>
  app().request(path, { method, headers: { 'X-User': user } });

describe('requireProjectAccess', () => {
  test.each(['owner', 'admin', 'member', 'org-member'])('%s can view', async (user) => {
    expect((await as(user, 'GET', '/projects/p1')).status).toBe(200);
  });

  test('a user without access and a missing project get the identical 404', async () => {
    const foreign = await as('stranger', 'GET', '/projects/p1');
    const missing = await as('owner', 'GET', '/projects/does-not-exist');

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  test('manage admits owner and admin, 403s viewers and contributors', async () => {
    expect((await as('owner', 'PATCH', '/projects/p1')).status).toBe(200);
    expect((await as('admin', 'PATCH', '/projects/p1')).status).toBe(200);

    const res = await as('org-member', 'PATCH', '/projects/p1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'admins only' });
    expect((await as('member', 'PATCH', '/projects/p1')).status).toBe(403);
  });

  test('a foreign project stays 404 even on a manage route', async () => {
    expect((await as('stranger', 'PATCH', '/projects/p1')).status).toBe(404);
  });

  test('reads the project id from a custom route param', async () => {
    expect((await as('org-member', 'GET', '/bindings/p1')).status).toBe(200);
    expect((await as('stranger', 'GET', '/bindings/p1')).status).toBe(404);
  });
});
