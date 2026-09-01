import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';
import { MockTunnelTimeoutError } from '../helpers/proxy-test-mocks.js';

process.env.RUNNER_AUTH_SECRET ??= 'test-secret';

function appWith(transport: ProxyTransport) {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.all('/api/*', createProxyToRunner(transport));
  return app;
}

const resolver = {
  resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://legacy.invalid' }),
  resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://legacy.invalid' }),
};

describe('gRPC-only runner proxy', () => {
  test('returns 502 without an active gRPC session even when legacy httpUrl exists', async () => {
    let tunnelCalls = 0;
    const response = await appWith({
      ...resolver,
      requests: {
        isAvailable: () => false,
        request: async () => {
          tunnelCalls += 1;
          throw new Error('must not dispatch');
        },
      },
    }).request('/api/browse');

    expect(response.status).toBe(502);
    expect(tunnelCalls).toBe(0);
  });

  test('returns 504 on a gRPC tunnel deadline without another transport attempt', async () => {
    let tunnelCalls = 0;
    const response = await appWith({
      ...resolver,
      requests: {
        isAvailable: () => true,
        request: async () => {
          tunnelCalls += 1;
          throw new MockTunnelTimeoutError('runner-1', 30_000);
        },
      },
    }).request('/api/messages', { method: 'POST', body: '{}' });

    expect(response.status).toBe(504);
    expect(tunnelCalls).toBe(1);
  });

  test('uses the gRPC tunnel for safe and unsafe methods', async () => {
    const methods: string[] = [];
    const app = appWith({
      ...resolver,
      requests: {
        isAvailable: () => true,
        request: async (_runnerId, request) => {
          methods.push(request.method);
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
        },
      },
    });

    expect((await app.request('/api/browse')).status).toBe(200);
    expect((await app.request('/api/messages', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(methods).toEqual(['GET', 'POST']);
  });
});
