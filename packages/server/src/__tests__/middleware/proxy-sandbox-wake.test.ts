import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import { errAsync, okAsync } from 'neverthrow';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner, type ProxyTransport } from '../../middleware/proxy.js';
import type { SandboxWaker } from '../../services/thread-sandboxes/sandbox-lifecycle.js';
import { fakeRunnerAccess } from '../helpers/runner-access-fakes.js';

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

const requests: NonNullable<ProxyTransport['requests']> = {
  isAvailable: () => true,
  request: async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  }),
};

/** The sandbox runner is offline until the waker resumes it. */
function sandboxThread(wakeSucceeds: boolean) {
  let awake = false;
  const wakes: Array<[string, string]> = [];
  const waker: SandboxWaker = {
    wake: (threadId, ownerId) => {
      wakes.push([threadId, ownerId]);
      if (!wakeSucceeds) {
        return errAsync({ kind: 'sandbox', message: 'expired', cause: 'expired' });
      }
      awake = true;
      return okAsync('sandbox-runner');
    },
  };
  const runnerAccess = fakeRunnerAccess({
    runnerFor: () => (awake ? 'sandbox-runner' : null),
    owners: { 'sandbox-runner': 'user-1' },
    unavailableReason: 'thread-sandbox-unavailable',
  });
  return { transport: { runnerAccess, requests, sandboxWaker: waker }, wakes };
}

describe('proxy wakes a stopped thread sandbox', () => {
  test('resumes the sandbox for its owner and retries the request once', async () => {
    const { transport, wakes } = sandboxThread(true);
    const response = await appWith(transport).request('/api/threads/t1/message', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(wakes).toEqual([['t1', 'user-1']]);
  });

  test('a failed wake answers 502 without retrying', async () => {
    const { transport, wakes } = sandboxThread(false);
    const response = await appWith(transport).request('/api/threads/t1/message', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(502);
    expect(wakes).toHaveLength(1);
  });

  test('other runner failures never trigger a wake', async () => {
    const wakes: string[] = [];
    const response = await appWith({
      runnerAccess: fakeRunnerAccess({ runnerFor: () => null }),
      requests,
      sandboxWaker: {
        wake: (threadId) => {
          wakes.push(threadId);
          return okAsync('r');
        },
      },
    }).request('/api/threads/t1/message', { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(wakes).toEqual([]);
  });
});

describe('proxy routes on the thread context header', () => {
  test("a workspace request carrying the open thread resolves that thread's runner", async () => {
    const targets: unknown[] = [];
    const response = await appWith({
      runnerAccess: fakeRunnerAccess({ onSelect: (_userId, target) => targets.push(target) }),
      requests,
    }).request('/api/files/read?path=%2Frepo%2Fa.ts', {
      headers: { 'X-Funny-Thread-Id': 't-box' },
    });
    expect(response.status).toBe(200);
    expect(targets).toEqual([
      {
        kind: 'request',
        path: '/api/files/read',
        query: { path: '/repo/a.ts', threadId: 't-box' },
      },
    ]);
  });

  test('a stopped sandbox named by the header is woken like a thread route', async () => {
    const { transport, wakes } = sandboxThread(true);
    const response = await appWith(transport).request('/api/browse/files?path=%2Frepo', {
      headers: { 'X-Funny-Thread-Id': 't1' },
    });
    expect(response.status).toBe(200);
    expect(wakes).toEqual([['t1', 'user-1']]);
  });
});
