/**
 * Regression: when the WS tunnel times out, the proxy must NOT fall back to
 * directHttpFetch. The runner already received the request and may still be
 * processing it; a fallback would deliver it twice and duplicate side effects
 * (e.g., persisting a user message twice and enqueuing two prompts on agents
 * that await the full turn in sendPrompt — Gemini ACP / Codex / Pi).
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  isRunnerConnected: () => true,
}));

let tunnelShouldTimeout = false;
let tunnelCalls = 0;

import { TunnelTimeoutError } from '../../services/ws-tunnel.js';

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  TunnelTimeoutError,
  tunnelFetch: async (runnerId: string) => {
    tunnelCalls++;
    if (tunnelShouldTimeout) {
      throw new TunnelTimeoutError(runnerId, 30_000);
    }
    throw new Error('socket not found');
  },
}));

mock.module('../../services/runner-resolver.js', () => ({
  resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://runner.local' }),
  resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://runner.local' }),
}));

import { describe, test, expect, beforeEach } from 'bun:test';

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

    globalThis.fetch = originalFetch;
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

    globalThis.fetch = originalFetch;
  });
});
