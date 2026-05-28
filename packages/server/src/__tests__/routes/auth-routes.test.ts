/**
 * Auth route wiring — verifies /api/auth/* is forwarded to Better Auth.
 */
import { mock } from 'bun:test';

const handlerCalls: Array<{ url: string; method: string }> = [];

mock.module('../../lib/auth.js', () => ({
  auth: {
    handler: (req: Request) => {
      handlerCalls.push({ url: req.url, method: req.method });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  },
}));

import { describe, test, expect, beforeEach } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { authRoutes } from '../../routes/auth.js';

describe('auth routes', () => {
  beforeEach(() => {
    handlerCalls.length = 0;
  });

  test('forwards GET /api/auth/session to auth.handler', async () => {
    const app = new Hono<ServerEnv>();
    app.route('/api/auth', authRoutes);

    const res = await app.request('/api/auth/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]?.method).toBe('GET');
    expect(handlerCalls[0]?.url).toContain('/api/auth/session');
  });

  test('forwards POST /api/auth/sign-in/username to auth.handler', async () => {
    const app = new Hono<ServerEnv>();
    app.route('/api/auth', authRoutes);

    const res = await app.request('/api/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });

    expect(res.status).toBe(200);
    expect(handlerCalls[0]?.method).toBe('POST');
    expect(handlerCalls[0]?.url).toContain('/api/auth/sign-in/username');
  });
});
