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
import { createProxyToRunner, proxyToRunner } from '../../middleware/proxy.js';

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

  test('regression: direct-HTTP → tunnel fallback re-signs with a fresh nonce so the retry is not a replay', async () => {
    // Reproduces the production 401: a loopback runner prefers direct HTTP; the
    // first attempt reaches the runtime (which records the nonce in its replay
    // cache) but the response socket closes, so the server retries over the
    // tunnel. If the retry reused the SAME nonce, the runtime would reject it as
    // a replay ("invalid signature") and the caller would see a spurious 401.
    __resetForwardedIdentityNonceCacheForTests();

    const directHeaders: Array<Record<string, string>> = [];
    const tunnelHeaders: Array<Record<string, string>> = [];

    const deps = {
      resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://127.0.0.1:3003' }),
      resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://127.0.0.1:3003' }),
      isRunnerConnected: () => true,
      isTunnelTimeoutError: () => false,
      // Direct HTTP: capture the signed headers, then fail like a dropped socket.
      directFetch: (async (_url: string, init: RequestInit) => {
        const captured: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => {
          captured[k.toLowerCase()] = v;
        });
        directHeaders.push(captured);
        throw new Error('The socket connection was closed unexpectedly.');
      }) as unknown as typeof fetch,
      // Tunnel: capture the (should-be-fresh) signed headers and succeed.
      tunnelFetch: async (_runnerId: string, req: { headers: Record<string, string> }) => {
        const captured: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) captured[k.toLowerCase()] = v;
        tunnelHeaders.push(captured);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
      },
    };

    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      c.set('userRole', 'admin');
      return next();
    });
    app.all('/api/*', createProxyToRunner(deps as any));

    const res = await app.request('/api/git/status?projectId=p1');
    expect(res.status).toBe(200);

    expect(directHeaders).toHaveLength(1);
    expect(tunnelHeaders).toHaveLength(1);

    const directNonce = directHeaders[0][NONCE_HEADER.toLowerCase()];
    const tunnelNonce = tunnelHeaders[0][NONCE_HEADER.toLowerCase()];
    // The two physical sends MUST carry distinct nonces.
    expect(directNonce).toBeTruthy();
    expect(tunnelNonce).toBeTruthy();
    expect(tunnelNonce).not.toBe(directNonce);

    // Simulate the runtime consuming the direct attempt's nonce first…
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'admin', orgId: null, orgName: null },
        'test-secret',
        directHeaders[0][SIGNATURE_HEADER.toLowerCase()],
        directHeaders[0][TIMESTAMP_HEADER.toLowerCase()],
        directNonce,
      ),
    ).toBe(true);
    // …the tunnel retry must STILL verify (it would be a replay with the old code).
    expect(
      verifyForwardedIdentity(
        { userId: 'user-1', role: 'admin', orgId: null, orgName: null },
        'test-secret',
        tunnelHeaders[0][SIGNATURE_HEADER.toLowerCase()],
        tunnelHeaders[0][TIMESTAMP_HEADER.toLowerCase()],
        tunnelNonce,
      ),
    ).toBe(true);
  });
});
