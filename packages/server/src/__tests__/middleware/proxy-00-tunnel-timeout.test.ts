/**
 * Regression: when the WS tunnel times out, the proxy must NOT fall back to
 * directHttpFetch. The runner already received the request and may still be
 * processing it; a fallback would deliver it twice and duplicate side effects
 * (e.g., persisting a user message twice and enqueuing two prompts on agents
 * that await the full turn in sendPrompt — Gemini ACP / Codex / Pi).
 *
 * File prefix `proxy-00-` ensures this loads before proxy-forwarded-identity.test.ts.
 * Bun caches proxy.js's ws-tunnel/ws-relay bindings from the first importer.
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  MockTunnelTimeoutError,
  createRunnerResolverMock,
  createWsRelayMock,
} from '../helpers/proxy-test-mocks.js';

let tunnelShouldTimeout = false;
let tunnelCalls = 0;

mock.module('../../services/ws-relay.js', () => createWsRelayMock(() => true));

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
  tunnelFetch: async (runnerId: string) => {
    tunnelCalls++;
    if (tunnelShouldTimeout) {
      throw new MockTunnelTimeoutError(runnerId, 30_000);
    }
    throw new Error('socket not found');
  },
}));

mock.module('../../services/runner-resolver.js', () => createRunnerResolverMock());

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { proxyToRunner } from '../../middleware/proxy.js';

function buildApp(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'user');
    return next();
  });
  app.all('/api/*', proxyToRunner);
  return app;
}

describe('proxyToRunner — tunnel timeout fallback', () => {
  let originalFetch: typeof globalThis.fetch;
  let directFetchCalls: number;

  beforeEach(() => {
    tunnelShouldTimeout = false;
    tunnelCalls = 0;
    directFetchCalls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      directFetchCalls++;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns 504 and does NOT fall back to direct HTTP on tunnel timeout', async () => {
    tunnelShouldTimeout = true;
    const app = buildApp();

    const res = await app.request('/api/threads/abc/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });

    expect(res.status).toBe(504);
    expect(tunnelCalls).toBe(1);
    expect(directFetchCalls).toBe(0);
    expect(await res.json()).toEqual({
      error: 'Runner did not respond in time. The request may still be processing.',
    });
  });

  test('still falls back to direct HTTP on non-timeout tunnel errors', async () => {
    tunnelShouldTimeout = false;
    const app = buildApp();

    const res = await app.request('/api/threads/abc/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(tunnelCalls).toBe(1);
    expect(directFetchCalls).toBe(1);
  });
});
