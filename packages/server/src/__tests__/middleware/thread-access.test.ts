/**
 * Unit tests for the centralized thread-access middleware.
 *
 * Verifies the two access classes (`requireThreadView` / `requireThreadOwner`),
 * existence-hiding 404s, that a share grant widens `canViewThread` (read) but
 * NOT owner-only routes, and that the resolved thread is reachable from the
 * handler via `c.get('thread')`.
 */

import { describe, test, expect } from 'bun:test';

import { Hono } from 'hono';

import {
  canViewThread,
  createThreadAccessMiddleware,
  isThreadOwner,
  type HasShare,
} from '../../middleware/thread-access.js';

const OWNER = 'owner-1';
const SHAREE = 'ana-2';
const STRANGER = 'bob-3';

const threadFixture = { id: 't1', userId: OWNER, projectId: 'p1' } as any;

/** Fake share lookup: only SHAREE holds a grant on t1. */
const hasShare: HasShare = async (threadId, userId) => threadId === 't1' && userId === SHAREE;

/** Build a tiny app whose requests are authenticated as `currentUser`. */
function makeApp(currentUser: string) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', currentUser);
    await next();
  });
  const { requireThreadView, requireThreadOwner } = createThreadAccessMiddleware(
    async (id: string) => (id === 't1' ? threadFixture : null),
    hasShare,
  );
  app.get('/view/:id', requireThreadView, (c) => c.json({ thread: c.get('thread') }));
  app.get('/owner/:id', requireThreadOwner, (c) => c.json({ thread: c.get('thread') }));
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
    expect(await canViewThread(threadFixture, STRANGER, hasShare)).toBe(false);
  });
});

describe('thread-access middleware', () => {
  test('owner is authorized on both view and owner classes', async () => {
    const app = makeApp(OWNER);

    const view = await app.request('/view/t1');
    expect(view.status).toBe(200);
    expect((await view.json()).thread.id).toBe('t1');

    const owner = await app.request('/owner/t1');
    expect(owner.status).toBe(200);
    expect((await owner.json()).thread.id).toBe('t1');
  });

  test('sharee passes the view class but NOT the owner-only class', async () => {
    const app = makeApp(SHAREE);

    expect((await app.request('/view/t1')).status).toBe(200);
    expect((await app.request('/owner/t1')).status).toBe(404);
  });

  test('stranger gets 404 from both classes', async () => {
    const app = makeApp(STRANGER);

    expect((await app.request('/view/t1')).status).toBe(404);
    expect((await app.request('/owner/t1')).status).toBe(404);
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
 * Mirrors the git-route gate wired in index.ts: thread-scoped git ops
 * (`/api/git/:id/*`) are owner-only, while project-scoped ops
 * (`/api/git/project/*`, `/api/git/status`) pass through ungated. The ordering
 * is load-bearing — the project routes MUST be registered before `:id/*` so the
 * literal `project` / `status` segments are not captured as a thread id.
 */
describe('git-route owner gate (server wiring)', () => {
  function makeGitApp(currentUser: string) {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('userId', currentUser);
      await next();
    });
    const { requireThreadOwner } = createThreadAccessMiddleware(
      async (id: string) => (id === 't1' ? threadFixture : null),
      hasShare,
    );
    const proxied = (c: any) => c.json({ proxied: true });
    app.all('/api/git/project/*', proxied);
    app.all('/api/git/status', proxied);
    app.all('/api/git/:id/*', requireThreadOwner, proxied);
    return app;
  }

  test('owner reaches the proxy on a thread-scoped git route', async () => {
    const res = await makeGitApp(OWNER).request('/api/git/t1/diff');
    expect(res.status).toBe(200);
    expect((await res.json()).proxied).toBe(true);
  });

  test('sharee is 404 on a thread-scoped git route (git stays owner-only)', async () => {
    const res = await makeGitApp(SHAREE).request('/api/git/t1/commit', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('project-scoped git ops are not thread-gated (pass through)', async () => {
    const proj = await makeGitApp(SHAREE).request('/api/git/project/p1/status');
    expect(proj.status).toBe(200);
    const status = await makeGitApp(SHAREE).request('/api/git/status?projectId=p1');
    expect(status.status).toBe(200);
  });
});
