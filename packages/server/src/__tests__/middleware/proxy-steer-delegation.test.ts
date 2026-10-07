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

import {
  ON_BEHALF_OF_THREAD_HEADER,
  SHARE_LEVEL_HEADER,
} from '@funny/shared/auth/forwarded-identity';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';
import { fakeRunnerAccess } from '../helpers/runner-access-fakes.js';

const OWNER = 'owner-1';
const STEERER = 'cleo-4';

process.env.RUNNER_AUTH_SECRET ??= 'test-secret';

/**
 * A gRPC transport that records which user id the runner was selected (and
 * certified) for, and captures the identity headers actually sent.
 */
function spyTransport() {
  const calls: string[] = [];
  const sentHeaders: Array<Record<string, string>> = [];
  const transport: ProxyTransport = {
    // `runner-owner` belongs to the OWNER; the steerer owns no runner at all.
    runnerAccess: fakeRunnerAccess({
      runnerFor: () => 'runner-owner',
      owners: { 'runner-owner': OWNER },
      onSelect: (userId) => calls.push(userId),
    }),
    requests: {
      isAvailable: () => true,
      request: async (_runnerId, request) => {
        sentHeaders.push(request.headers);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
        };
      },
    },
  };
  return { transport, calls, sentHeaders };
}

/** Build an app that authenticates as `currentUser` and, when `thread` is
 *  provided, stashes it on context exactly like requireThreadSteer would. */
function makeApp(currentUser: string, thread?: { id: string; userId: string }) {
  const { transport, calls, sentHeaders } = spyTransport();
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', currentUser);
    if (thread) c.set('thread', thread as any);
    await next();
  });
  app.all('/api/threads/:id/message', createProxyToRunner(transport));
  return { app, calls, sentHeaders };
}

describe('proxy steer-share delegation', () => {
  test('owner request resolves by the owner id (no delegation)', async () => {
    const thread = { id: 't1', userId: OWNER };
    const { app, calls } = makeApp(OWNER, thread);

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([OWNER]);
  });

  test('steer sharee request is delegated to the OWNER runner, signed as the sharee', async () => {
    const thread = { id: 't1', userId: OWNER };
    const { app, calls, sentHeaders } = makeApp(STEERER, thread);

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    // Resolution crossed to the owner — NOT the sharee (who has no runner).
    expect(calls).toEqual([OWNER]);
    // The runner is the owner's, but the identity signed in is the sharee's,
    // bound to the thread with a `steer` claim.
    expect(sentHeaders[0]!['X-Forwarded-User']).toBe(STEERER);
    expect(sentHeaders[0]![SHARE_LEVEL_HEADER]).toBe('steer');
    expect(sentHeaders[0]![ON_BEHALF_OF_THREAD_HEADER]).toBe('t1');
  });

  test('without a loaded thread, no delegation happens (resolves by requester)', async () => {
    // The requester owns no runner, so certification refuses the owner's runner.
    const { app, calls, sentHeaders } = makeApp(STEERER); // no thread on context

    const res = await app.request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(calls).toEqual([STEERER]);
    expect(sentHeaders).toEqual([]);
  });
});
