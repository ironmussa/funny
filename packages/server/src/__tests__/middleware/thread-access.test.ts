/**
 * Unit tests for the centralized thread-access middleware.
 *
 * Verifies the three access classes (`requireThreadView` / `requireThreadOwner`
 * / `requireThreadSteer`), existence-hiding 404s, that a share grant widens
 * `canViewThread` (read) but NOT owner-only routes, that only a `steer` grant
 * widens `canSteerThread`, and that the resolved thread is reachable from the
 * handler via `c.get('thread')`.
 */

import { describe, test, expect } from 'bun:test';

import { Hono } from 'hono';

import {
  canSteerThread,
  canViewThread,
  createThreadAccessMiddleware,
  isThreadOwner,
  type GetShareLevel,
  type HasShare,
} from '../../middleware/thread-access.js';

const OWNER = 'owner-1';
const SHAREE = 'ana-2'; // holds a `view` grant
const STEERER = 'cleo-4'; // holds a `steer` grant
const STRANGER = 'bob-3'; // no grant

const threadFixture = { id: 't1', userId: OWNER, projectId: 'p1' } as any;

/** Fake share lookups: SHAREE has view, STEERER has steer, nobody else. */
const hasShare: HasShare = async (threadId, userId) =>
  threadId === 't1' && (userId === SHAREE || userId === STEERER);
const getShareLevel: GetShareLevel = async (threadId, userId) => {
  if (threadId !== 't1') return null;
  if (userId === STEERER) return 'steer';
  if (userId === SHAREE) return 'view';
  return null;
};

/** Build a tiny app whose requests are authenticated as `currentUser`. */
function makeApp(currentUser: string) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', currentUser);
    await next();
  });
  const { requireThreadView, requireThreadOwner, requireThreadSteer } =
    createThreadAccessMiddleware(
      async (id: string) => (id === 't1' ? threadFixture : null),
      (thread, userId) => canViewThread(thread, userId, hasShare),
      (thread, userId) => canSteerThread(thread, userId, getShareLevel),
    );
  app.get('/view/:id', requireThreadView, (c) => c.json({ thread: c.get('thread') }));
  app.get('/owner/:id', requireThreadOwner, (c) => c.json({ thread: c.get('thread') }));
  app.get('/steer/:id', requireThreadSteer, (c) => c.json({ thread: c.get('thread') }));
  return app;
}

describe('thread-access predicates', () => {
  test('isThreadOwner is true only for the owner', () => {
    expect(isThreadOwner(threadFixture, OWNER)).toBe(true);
    expect(isThreadOwner(threadFixture, SHAREE)).toBe(false);
  });

  test('canViewThread admits the owner and any sharee, rejects strangers', async () => {
    expect(await canViewThread(threadFixture, OWNER, hasShare)).toBe(true);
    expect(await canViewThread(threadFixture, SHAREE, hasShare)).toBe(true);
    expect(await canViewThread(threadFixture, STEERER, hasShare)).toBe(true);
    expect(await canViewThread(threadFixture, STRANGER, hasShare)).toBe(false);
  });

  test('canSteerThread admits the owner and steer sharees only', async () => {
    expect(await canSteerThread(threadFixture, OWNER, getShareLevel)).toBe(true);
    expect(await canSteerThread(threadFixture, STEERER, getShareLevel)).toBe(true);
    // A view-only sharee may NOT steer.
    expect(await canSteerThread(threadFixture, SHAREE, getShareLevel)).toBe(false);
    expect(await canSteerThread(threadFixture, STRANGER, getShareLevel)).toBe(false);
  });
});

describe('thread-access middleware', () => {
  test('owner is authorized on view, owner, and steer classes', async () => {
    const app = makeApp(OWNER);

    expect((await app.request('/view/t1')).status).toBe(200);
    expect((await app.request('/owner/t1')).status).toBe(200);
    expect((await app.request('/steer/t1')).status).toBe(200);
  });

  test('view sharee passes view but NOT owner or steer', async () => {
    const app = makeApp(SHAREE);

    expect((await app.request('/view/t1')).status).toBe(200);
    expect((await app.request('/owner/t1')).status).toBe(404);
    expect((await app.request('/steer/t1')).status).toBe(404);
  });

  test('steer sharee passes view and steer but NOT owner', async () => {
    const app = makeApp(STEERER);

    expect((await app.request('/view/t1')).status).toBe(200);
    expect((await app.request('/steer/t1')).status).toBe(200);
    expect((await app.request('/owner/t1')).status).toBe(404);
  });

  test('stranger gets 404 from all classes', async () => {
    const app = makeApp(STRANGER);

    expect((await app.request('/view/t1')).status).toBe(404);
    expect((await app.request('/owner/t1')).status).toBe(404);
    expect((await app.request('/steer/t1')).status).toBe(404);
  });

  test('missing thread is 404 (same as unauthorized — existence hiding)', async () => {
    const app = makeApp(OWNER);

    const missing = await app.request('/view/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Thread not found' });

    // A stranger hitting an existing thread gets the byte-identical response
    // as anyone hitting a nonexistent id.
    const crossTenant = await makeApp(STRANGER).request('/view/t1');
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: 'Thread not found' });
  });

  test('the loaded thread is reachable from the handler via c.get("thread")', async () => {
    const app = makeApp(OWNER);
    const res = await app.request('/owner/t1');
    const body = await res.json();
    expect(body.thread).toMatchObject({ id: 't1', userId: OWNER, projectId: 'p1' });
  });
});

/**
 * Mirrors the git-route gate wired in index.ts after thread-sharing-steer:
 * READ-ONLY thread-scoped git GETs (status / diff / log / commit details) are
 * allow-listed for steer sharees, while every other thread-scoped git op stays
 * owner-only. Project-scoped ops pass through ungated. Ordering is load-bearing:
 * the project routes and the read GETs MUST be registered before the owner-only
 * `:id/*` catch-all.
 */
describe('git-route gate (server wiring)', () => {
  function makeGitApp(currentUser: string) {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('userId', currentUser);
      await next();
    });
    const { requireThreadOwner, requireThreadSteer } = createThreadAccessMiddleware(
      async (id: string) => (id === 't1' ? threadFixture : null),
      (thread, userId) => canViewThread(thread, userId, hasShare),
      (thread, userId) => canSteerThread(thread, userId, getShareLevel),
    );
    const proxied = (c: any) => c.json({ proxied: true });
    app.all('/api/git/project/*', proxied);
    app.all('/api/git/status', proxied);
    app.get('/api/git/:id/status', requireThreadSteer, proxied);
    app.get('/api/git/:id/diff', requireThreadSteer, proxied);
    app.get('/api/git/:id/diff/*', requireThreadSteer, proxied);
    app.get('/api/git/:id/log', requireThreadSteer, proxied);
    app.get('/api/git/:id/graph-log', requireThreadSteer, proxied);
    app.get('/api/git/:id/commit/*', requireThreadSteer, proxied);
    app.all('/api/git/:id/*', requireThreadOwner, proxied);
    return app;
  }

  test('owner reaches the proxy on read and write git routes', async () => {
    expect((await makeGitApp(OWNER).request('/api/git/t1/diff')).status).toBe(200);
    expect((await makeGitApp(OWNER).request('/api/git/t1/commit', { method: 'POST' })).status).toBe(
      200,
    );
  });

  test('steer sharee reaches read-only git but NOT writes', async () => {
    expect((await makeGitApp(STEERER).request('/api/git/t1/status')).status).toBe(200);
    expect((await makeGitApp(STEERER).request('/api/git/t1/diff')).status).toBe(200);
    expect((await makeGitApp(STEERER).request('/api/git/t1/log')).status).toBe(200);
    // Writes stay owner-only → 404.
    expect(
      (await makeGitApp(STEERER).request('/api/git/t1/commit', { method: 'POST' })).status,
    ).toBe(404);
    expect(
      (await makeGitApp(STEERER).request('/api/git/t1/stage', { method: 'POST' })).status,
    ).toBe(404);
  });

  test('view-only sharee is 404 on git reads AND writes', async () => {
    expect((await makeGitApp(SHAREE).request('/api/git/t1/diff')).status).toBe(404);
    expect(
      (await makeGitApp(SHAREE).request('/api/git/t1/commit', { method: 'POST' })).status,
    ).toBe(404);
  });

  test('project-scoped git ops are not thread-gated (pass through)', async () => {
    const proj = await makeGitApp(SHAREE).request('/api/git/project/p1/status');
    expect(proj.status).toBe(200);
    const status = await makeGitApp(SHAREE).request('/api/git/status?projectId=p1');
    expect(status.status).toBe(200);
  });
});
