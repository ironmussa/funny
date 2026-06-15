/**
 * Steer-share delegation in the proxy (thread-sharing-steer).
 *
 * The runner-isolation invariant resolves the requester's OWN runner. The one
 * intentional exception: when an allow-listed route has already authorized a
 * `steer` sharee, the thread-access middleware has loaded the thread into
 * context, and the proxy must resolve by the thread OWNER's id (the thread
 * lives on the owner's runner). These tests assert exactly which user id the
 * proxy hands to `resolveRunner`, with no real runner involved.
 */

import { describe, test, expect } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';

const OWNER = 'owner-1';
const STEERER = 'cleo-4';

process.env.RUNNER_AUTH_SECRET ??= 'test-secret';

/** A transport that records the userId resolveRunner was called with and
 *  answers via a direct (non-tunnel) HTTP fetch. */
function spyTransport() {
  const calls: string[] = [];
  const transport: ProxyTransport = {
    resolveRunner: async (_path, _query, userId) => {
      calls.push(userId ?? '<none>');
      return { runnerId: 'runner-owner', httpUrl: 'http://runner.local' };
    },
    resolveAnyRunner: async () => ({ runnerId: 'runner-owner', httpUrl: 'http://runner.local' }),
    isRunnerConnected: () => false, // force the direct-HTTP path
    tunnelFetch: async () => {
      throw new Error('should not tunnel');
    },
    isTunnelTimeoutError: () => false,
    directFetch: async () => new Response('{"ok":true}', { status: 200 }),
  };
  return { transport, calls };
}

/** Build an app that authenticates as `currentUser` and, when `thread` is
 *  provided, stashes it on context exactly like requireThreadSteer would. */
function makeApp(currentUser: string, thread?: { id: string; userId: string }) {
  const { transport, calls } = spyTransport();
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', currentUser);
    if (thread) c.set('thread', thread as any);
    await next();
  });
  app.all('/api/threads/:id/message', createProxyToRunner(transport));
  return { app, calls };
}

describe('proxy steer-share delegation', () => {
  test('owner request resolves by the owner id (no delegation)', async () => {
    const thread = { id: 't1', userId: OWNER };
    const { app, calls } = makeApp(OWNER, thread);

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([OWNER]);
  });

  test('steer sharee request is delegated to the OWNER runner', async () => {
    const thread = { id: 't1', userId: OWNER };
    const { app, calls } = makeApp(STEERER, thread);

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    // Resolution crossed to the owner — NOT the sharee (who has no runner).
    expect(calls).toEqual([OWNER]);
  });

  test('without a loaded thread, no delegation happens (resolves by requester)', async () => {
    const { app, calls } = makeApp(STEERER); // no thread on context

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([STEERER]);
  });
});
