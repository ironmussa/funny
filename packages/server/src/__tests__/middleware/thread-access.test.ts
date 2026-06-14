/**
 * Unit tests for the centralized thread-access middleware.
 *
 * Verifies the two access classes (`requireThreadView` / `requireThreadOwner`),
 * existence-hiding 404s, and that the resolved thread is reachable from the
 * handler via `c.get('thread')`.
 */

import { describe, test, expect } from 'bun:test';

import { Hono } from 'hono';

import {
  canViewThread,
  createThreadAccessMiddleware,
  isThreadOwner,
} from '../../middleware/thread-access.js';

const OWNER = 'owner-1';
const OTHER = 'other-2';

const threadFixture = { id: 't1', userId: OWNER, projectId: 'p1' } as any;

/** Build a tiny app whose requests are authenticated as `currentUser`. */
function makeApp(currentUser: string) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', currentUser);
    await next();
  });
  const { requireThreadView, requireThreadOwner } = createThreadAccessMiddleware(
    async (id: string) => (id === 't1' ? threadFixture : null),
  );
  app.get('/view/:id', requireThreadView, (c) => c.json({ thread: c.get('thread') }));
  app.get('/owner/:id', requireThreadOwner, (c) => c.json({ thread: c.get('thread') }));
  return app;
}

describe('thread-access predicates', () => {
  test('isThreadOwner is true only for the owner', () => {
    expect(isThreadOwner(threadFixture, OWNER)).toBe(true);
    expect(isThreadOwner(threadFixture, OTHER)).toBe(false);
  });

  test('canViewThread today equals ownership', () => {
    expect(canViewThread(threadFixture, OWNER)).toBe(true);
    expect(canViewThread(threadFixture, OTHER)).toBe(false);
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

  test('non-owner gets 404 from both classes', async () => {
    const app = makeApp(OTHER);

    expect((await app.request('/view/t1')).status).toBe(404);
    expect((await app.request('/owner/t1')).status).toBe(404);
  });

  test('missing thread is 404 (same as unauthorized — existence hiding)', async () => {
    const app = makeApp(OWNER);

    const missing = await app.request('/view/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Thread not found' });

    // A non-owner hitting an existing thread gets the byte-identical response
    // as anyone hitting a nonexistent id.
    const crossTenant = await makeApp(OTHER).request('/view/t1');
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
