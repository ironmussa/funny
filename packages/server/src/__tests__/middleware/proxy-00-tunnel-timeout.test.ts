/**
 * Regression: when the WS tunnel times out, the proxy must NOT fall back to
 * directHttpFetch. The runner already received the request and may still be
 * processing it; a fallback would deliver it twice and duplicate side effects.
 *
 * Determinism: this suite injects ALL transport deps (including the HTTP client)
 * via `createProxyToRunner` — it uses neither `mock.module` nor a global `fetch`
 * override. Bun runs test files with shared process globals, so anything global
 * (mock.module registry, `globalThis.fetch`) can be mutated by another file mid-
 * test; that historically made these assertions flaky. Pure injection means the
 * handler under test only ever touches the fakes created here.
 */

import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

class TunnelTimeoutError extends Error {
  constructor(
    readonly runnerId: string,
    readonly timeoutMs: number,
  ) {
    super(`Tunnel to runner ${runnerId} timed out after ${timeoutMs}ms`);
    this.name = 'TunnelTimeoutError';
  }
}

const RESOLVED_RUNNER = { runnerId: 'runner-1', httpUrl: 'http://runner.local' };

function makeDeps(overrides: Partial<ProxyTransport>): ProxyTransport {
  return {
    resolveRunner: async () => RESOLVED_RUNNER,
    resolveAnyRunner: async () => RESOLVED_RUNNER,
    isRunnerConnected: () => true,
    tunnelFetch: (async () => {
      throw new Error('tunnelFetch not configured for this test');
    }) as ProxyTransport['tunnelFetch'],
    isTunnelTimeoutError: (err: unknown) => err instanceof TunnelTimeoutError,
    directFetch: (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as ProxyTransport['directFetch'],
    ...overrides,
  };
}

function buildApp(deps: ProxyTransport): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'user');
    return next();
  });
  app.all('/api/*', createProxyToRunner(deps));
  return app;
}

describe('proxyToRunner — tunnel timeout fallback', () => {
  test('prefers direct HTTP for loopback runner URLs before using the tunnel', async () => {
    let tunnelCalls = 0;
    let directFetchCalls = 0;
    const deps = makeDeps({
      resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://127.0.0.1:3003' }),
      tunnelFetch: (async () => {
        tunnelCalls++;
        throw new Error('tunnel should not be used');
      }) as ProxyTransport['tunnelFetch'],
      directFetch: (async () => {
        directFetchCalls++;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as ProxyTransport['directFetch'],
    });
    const app = buildApp(deps);

    const res = await app.request('/api/threads/abc/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(directFetchCalls).toBe(1);
    expect(tunnelCalls).toBe(0);
  });

  test('returns 504 and does NOT fall back to direct HTTP on tunnel timeout', async () => {
    let tunnelCalls = 0;
    let directFetchCalls = 0;
    const deps = makeDeps({
      tunnelFetch: (async (runnerId: string) => {
        tunnelCalls++;
        throw new TunnelTimeoutError(runnerId, 30_000);
      }) as ProxyTransport['tunnelFetch'],
      directFetch: (async () => {
        directFetchCalls++;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as ProxyTransport['directFetch'],
    });
    const app = buildApp(deps);

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

  test('falls back to direct HTTP on tunnel timeout for a safe GET (e.g. file read)', async () => {
    let tunnelCalls = 0;
    let directFetchCalls = 0;
    const deps = makeDeps({
      tunnelFetch: (async (runnerId: string) => {
        tunnelCalls++;
        throw new TunnelTimeoutError(runnerId, 30_000);
      }) as ProxyTransport['tunnelFetch'],
      directFetch: (async () => {
        directFetchCalls++;
        return new Response(JSON.stringify({ content: 'file body' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as ProxyTransport['directFetch'],
    });
    const app = buildApp(deps);

    const res = await app.request('/api/files/read?path=/some/file.ts', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'file body' });
    expect(tunnelCalls).toBe(1);
    // The GET is safe/idempotent, so a tunnel timeout retries over direct HTTP
    // instead of dead-ending at 504.
    expect(directFetchCalls).toBe(1);
  });

  test('still falls back to direct HTTP on non-timeout tunnel errors', async () => {
    let tunnelCalls = 0;
    let directFetchCalls = 0;
    const deps = makeDeps({
      tunnelFetch: (async () => {
        tunnelCalls++;
        throw new Error('socket not found');
      }) as ProxyTransport['tunnelFetch'],
      directFetch: (async () => {
        directFetchCalls++;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as ProxyTransport['directFetch'],
    });
    const app = buildApp(deps);

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
