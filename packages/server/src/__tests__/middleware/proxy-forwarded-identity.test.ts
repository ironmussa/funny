import { beforeEach, describe, expect, test } from 'bun:test';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  __resetForwardedIdentityNonceCacheForTests,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { Hono } from 'hono';

import type { ServerEnv, UserRole } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

describe('gRPC proxy forwarded identity', () => {
  beforeEach(() => __resetForwardedIdentityNonceCacheForTests());

  function setup(role?: UserRole) {
    const captured: Array<Record<string, string>> = [];
    const transport: ProxyTransport = {
      resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: null }),
      resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: null }),
      requests: {
        isAvailable: () => true,
        request: async (_runnerId, request) => {
          captured.push(
            Object.fromEntries(
              Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
            ),
          );
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
        },
      },
    };
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      if (role) c.set('userRole', role);
      await next();
    });
    app.all('/api/*', createProxyToRunner(transport));
    return { app, captured };
  }

  test('signs the same role carried in the forwarded headers', async () => {
    const { app, captured } = setup('admin');
    expect((await app.request('/api/projects/p1/branches')).status).toBe(200);
    const headers = captured[0]!;
    expect(headers['x-forwarded-role']).toBe('admin');
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'admin', orgId: null, orgName: null },
        'test-secret',
        headers[SIGNATURE_HEADER.toLowerCase()],
        headers[TIMESTAMP_HEADER.toLowerCase()],
        headers[NONCE_HEADER.toLowerCase()],
      ),
    ).toBe(true);
  });

  test('defaults the role to user', async () => {
    const { app, captured } = setup();
    expect((await app.request('/api/projects/p1/branches')).status).toBe(200);
    const headers = captured[0]!;
    expect(headers['x-forwarded-role']).toBe('user');
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'user', orgId: null, orgName: null },
        'test-secret',
        headers[SIGNATURE_HEADER.toLowerCase()],
        headers[TIMESTAMP_HEADER.toLowerCase()],
        headers[NONCE_HEADER.toLowerCase()],
      ),
    ).toBe(true);
  });

  test('parallel gRPC sends receive unique valid nonces', async () => {
    const { app, captured } = setup('admin');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.request('/api/projects/p1/branches')),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(captured.map((headers) => headers[NONCE_HEADER.toLowerCase()])).size).toBe(10);
  });
});
