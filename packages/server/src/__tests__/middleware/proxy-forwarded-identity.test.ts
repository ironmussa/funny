/**
 * Regressions around the server proxy's forwarded-identity signing:
 *
 *  1. The server MUST sign with the same role value the runtime will use when
 *     verifying. The runtime defaults a missing `X-Forwarded-Role` header to
 *     `'user'`; if the proxy signs with `null`/`''` while the runtime verifies
 *     with `'user'`, the HMAC mismatches and every proxied request 401s.
 *
 *  2. Parallel proxied requests sharing a millisecond (e.g., 10 API calls
 *     fired by a single browser refresh) MUST each verify. The nonce header
 *     makes every signature unique so the runtime's replay cache no longer
 *     false-positives on legitimate bursts.
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  MockTunnelTimeoutError,
  createRunnerResolverMock,
  createWsRelayMock,
} from '../helpers/proxy-test-mocks.js';

mock.module('../../services/ws-relay.js', () => createWsRelayMock(() => false));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  TunnelTimeoutError: MockTunnelTimeoutError,
  isTunnelTimeoutError: (err: unknown) =>
    err instanceof MockTunnelTimeoutError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Error).name === 'TunnelTimeoutError' &&
      'runnerId' in err &&
      'timeoutMs' in err),
  tunnelFetch: async () => {
    throw new Error('not used');
  },
}));

mock.module('../../services/runner-resolver.js', () => createRunnerResolverMock());

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  __resetForwardedIdentityNonceCacheForTests,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { proxyToRunner } from '../../middleware/proxy.js';

describe('proxyToRunner — forwarded identity signature payload', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedHeadersByCall: Array<Record<string, string>> = [];

  beforeEach(() => {
    capturedHeadersByCall = [];
    __resetForwardedIdentityNonceCacheForTests();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const captured: Record<string, string> = {};
      headers.forEach((value, key) => {
        captured[key.toLowerCase()] = value;
      });
      capturedHeadersByCall.push(captured);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function lastHeaders(): Record<string, string> {
    return capturedHeadersByCall.at(-1) ?? {};
  }

  test('signs with a role that matches the X-Forwarded-Role header (userRole set)', async () => {
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      c.set('userRole', 'admin');
      return next();
    });
    app.all('/api/*', proxyToRunner);

    const res = await app.request('/api/projects/p1/branches');
    expect(res.status).toBe(200);

    const h = lastHeaders();
    expect(h['x-forwarded-role']).toBe('admin');
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'admin', orgId: null, orgName: null },
        'test-secret',
        h[SIGNATURE_HEADER.toLowerCase()],
        h[TIMESTAMP_HEADER.toLowerCase()],
        h[NONCE_HEADER.toLowerCase()],
      ),
    ).toBe(true);
  });

  test('falls back to role="user" and signs with that same default when userRole is unset', async () => {
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      return next();
    });
    app.all('/api/*', proxyToRunner);

    const res = await app.request('/api/projects/p1/branches');
    expect(res.status).toBe(200);

    const h = lastHeaders();
    expect(h['x-forwarded-role']).toBe('user');
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'user', orgId: null, orgName: null },
        'test-secret',
        h[SIGNATURE_HEADER.toLowerCase()],
        h[TIMESTAMP_HEADER.toLowerCase()],
        h[NONCE_HEADER.toLowerCase()],
      ),
    ).toBe(true);
  });

  test('regression: parallel proxied requests each produce a unique signature + nonce that verifies', async () => {
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      c.set('userRole', 'admin');
      return next();
    });
    app.all('/api/*', proxyToRunner);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.request('/api/projects/p1/branches')),
    );
    for (const res of responses) expect(res.status).toBe(200);

    const sigs = new Set(capturedHeadersByCall.map((h) => h[SIGNATURE_HEADER.toLowerCase()]));
    const nonces = new Set(capturedHeadersByCall.map((h) => h[NONCE_HEADER.toLowerCase()]));
    expect(sigs.size).toBe(10);
    expect(nonces.size).toBe(10);

    for (const h of capturedHeadersByCall) {
      expect(
        verifyForwardedIdentity(
          { userId: 'user-1', role: 'admin', orgId: null, orgName: null },
          'test-secret',
          h[SIGNATURE_HEADER.toLowerCase()],
          h[TIMESTAMP_HEADER.toLowerCase()],
          h[NONCE_HEADER.toLowerCase()],
        ),
      ).toBe(true);
    }
  });
});
