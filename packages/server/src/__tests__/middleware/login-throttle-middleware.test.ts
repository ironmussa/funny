/**
 * The sign-in throttle middleware reads the account identifier from the
 * request body (a copy: Better Auth reads the original stream next).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { log } from '../../lib/logger.js';
import { recordLoginFailure, resetLoginThrottle } from '../../lib/login-throttle.js';
import type { ServerEnv } from '../../lib/types.js';
import { loginThrottleMiddleware } from '../../middleware/login-throttle.js';

let logInfo: ReturnType<typeof spyOn>;
let logWarn: ReturnType<typeof spyOn>;
beforeAll(() => {
  logInfo = spyOn(log, 'info').mockImplementation(() => log);
  logWarn = spyOn(log, 'warn').mockImplementation(() => log);
});
afterAll(() => {
  logInfo.mockRestore();
  logWarn.mockRestore();
});
afterEach(() => resetLoginThrottle());

function app(status: ContentfulStatusCode = 401) {
  const hono = new Hono<ServerEnv>();
  hono.use('/sign-in', loginThrottleMiddleware);
  hono.post('/sign-in', async (c) => c.json({ echoed: await c.req.text() }, status));
  return hono;
}

function lock(identifier: string) {
  for (let i = 0; i < 10; i++) recordLoginFailure(identifier);
}

function signIn(body: string, status?: ContentfulStatusCode) {
  return app(status).request('/sign-in', { method: 'POST', body });
}

describe('loginThrottleMiddleware', () => {
  test.each(['username', 'email', 'identifier'])(
    'refuses a locked account named by %s',
    async (field) => {
      lock('alice');
      const res = await signIn(JSON.stringify({ [field]: 'Alice' }));
      expect(res.status).toBe(429);
    },
  );

  test('passes the unread body on to the handler', async () => {
    const body = JSON.stringify({ username: 'bob', password: 'x' });
    const res = await signIn(body, 200);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: body });
  });

  test('counts a failed sign-in against the identifier', async () => {
    for (let i = 0; i < 10; i++) await signIn(JSON.stringify({ email: 'carol' }));
    expect((await signIn(JSON.stringify({ email: 'carol' }))).status).toBe(429);
  });

  test.each([
    ['a non-JSON body', 'not json'],
    ['an empty body', ''],
    ['a JSON array', '["alice"]'],
    ['a non-string identifier', JSON.stringify({ username: 42 })],
  ])('lets %s through without throttling', async (_label, body) => {
    lock('alice');
    lock('42');
    const res = await signIn(body);
    expect(res.status).toBe(401);
  });
});
