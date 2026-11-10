import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import { rateLimit } from '../../middleware/rate-limit.js';

function app(skip?: (path: string) => boolean) {
  const hono = new Hono<{ Variables: { userId: string } }>();
  hono.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  hono.use('*', rateLimit({ windowMs: 60_000, max: 2, skip: skip && ((c) => skip(c.req.path)) }));
  hono.get('*', (c) => c.text('ok'));
  return hono;
}

describe('rateLimit', () => {
  test('refuses requests over the limit with 429', async () => {
    const hono = app();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await hono.request('/api/x')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('skipped requests are not counted and never refused', async () => {
    const hono = app((path) => path.startsWith('/api/frames/'));
    for (let i = 0; i < 10; i++) expect((await hono.request(`/api/frames/${i}`)).status).toBe(200);
    // The skipped burst left the bucket untouched.
    expect((await hono.request('/api/x')).status).toBe(200);
    expect((await hono.request('/api/x')).status).toBe(200);
    expect((await hono.request('/api/x')).status).toBe(429);
  });
});

/**
 * Anonymous callers are bucketed by the peer address the host supplies in the
 * env (`IP`, as the Bun host passes it). It was read through `hono/bun`
 * getConnInfo, which looks for a Bun server in the env, always threw, and
 * left anonymous requests unlimited.
 */
describe('rateLimit — anonymous callers by host-supplied IP', () => {
  function anonymousApp() {
    const hono = new Hono();
    hono.use('*', rateLimit({ windowMs: 60_000, max: 2 }));
    hono.post('*', (c) => c.text('ok'));
    return hono;
  }
  const from = (hono: Hono, address: string) =>
    hono.request('/api/invite-links/register', { method: 'POST' }, { IP: { address } });

  test('refuses an anonymous IP over the limit', async () => {
    const hono = anonymousApp();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await from(hono, '203.0.113.7')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('keeps a separate bucket per IP', async () => {
    const hono = anonymousApp();
    await from(hono, '203.0.113.7');
    await from(hono, '203.0.113.7');
    expect((await from(hono, '203.0.113.7')).status).toBe(429);
    expect((await from(hono, '198.51.100.2')).status).toBe(200);
  });

  test('without any address the request is let through (fail open)', async () => {
    const hono = anonymousApp();
    for (let i = 0; i < 5; i++) {
      expect((await hono.request('/x', { method: 'POST' })).status).toBe(200);
    }
  });
});
