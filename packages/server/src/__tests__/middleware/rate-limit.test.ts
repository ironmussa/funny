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
