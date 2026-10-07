/**
 * Integration tests for /api/scheduler/system/* (cross-tenant brain surface).
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';
process.env.SCHEDULER_AUTH_SECRET = 'scheduler-test-secret';

import { createAuthApiMock, resetAuthMiddlewareCache } from '../helpers/auth-mock.js';

mock.module('../../lib/auth.js', () => ({
  auth: {
    api: createAuthApiMock({
      getSession: async () => null,
    }),
  },
}));

const relayCalls: Array<{ userId: string; event: Record<string, unknown> }> = [];
let tunnelFetchImpl: (
  runnerId: string,
  req: { method: string; path: string; headers: Record<string, string>; body: string | null },
) => Promise<{ status: number; body: string | null }> = () =>
  Promise.reject(new Error('tunnel not configured'));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';

/** True when the headers carry a valid signed forwarded identity for `userId`. */
function signedFor(userId: string, headers: Record<string, string>): boolean {
  return verifyForwardedIdentity(
    { userId, role: 'user', orgId: null, orgName: null },
    'test-secret',
    headers[SIGNATURE_HEADER],
    headers[TIMESTAMP_HEADER],
    headers[NONCE_HEADER],
  );
}
import { authMiddleware } from '../../middleware/auth.js';
import { schedulerSystemRoutes } from '../../routes/scheduler-system.js';
import type { BrowserEventSink } from '../../services/runner-ports.js';
import { uncacheThread } from '../../services/runner-resolver.js';
import { __resetRunnerScopeCache, setProjectDedicatedRunner } from '../../services/runner-scope.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  seedSchedulerRun,
  seedPipeline,
  seedPipelineRun,
  seedProject,
  seedRunner,
  seedThread,
  seedThreadDependency,
} from '../helpers/test-db.js';

const browserEvents: BrowserEventSink = {
  publish: () => {},
  toUser: (userId, event) => relayCalls.push({ userId, event }),
  toAll: () => {},
  toThreadStream: () => {},
  toThreadPresence: () => {},
  toThreadViewers: () => {},
  evictFromThread: () => {},
};

function systemApp() {
  const app = new Hono<ServerEnv>();
  const request = app.request.bind(app);
  app.request = ((input: RequestInfo | URL, init?: RequestInit, env?: ServerEnv['Bindings']) =>
    request(
      input,
      init,
      env ?? {
        browserEvents,
        runnerRequests: {
          isAvailable: () => true,
          request: (runnerId, request) => tunnelFetchImpl(runnerId, request as any) as any,
        },
        // Dispatch routes through the resolver, which only picks connected runners.
        runnerPresence: { isAvailable: () => true } as any,
      },
    )) as typeof app.request;
  app.use('*', authMiddleware);
  app.route('/api/scheduler/system', schedulerSystemRoutes);
  return app;
}

function schedulerHeaders(extra: Record<string, string> = {}) {
  return {
    'X-Scheduler-Auth': 'scheduler-test-secret',
    ...extra,
  };
}

describe('Scheduler System Routes (Integration)', () => {
  let t: TestApp;
  let app: Hono<ServerEnv>;

  beforeAll(async () => {
    t = await createTestApp();
    app = systemApp();
  });

  beforeEach(async () => {
    t.cleanup();
    uncacheThread('t1');
    relayCalls.length = 0;
    tunnelFetchImpl = () => Promise.reject(new Error('tunnel not configured'));
    await resetAuthMiddlewareCache();
  });

  describe('auth gate', () => {
    test('returns 401 without X-Scheduler-Auth', async () => {
      const res = await app.request('/api/scheduler/system/runs');
      expect(res.status).toBe(401);
    });

    test('returns 401 with invalid scheduler secret', async () => {
      const res = await app.request('/api/scheduler/system/runs', {
        headers: { 'X-Scheduler-Auth': 'orch-bad-secretx' },
      });
      expect(res.status).toBe(401);
    });

    test('returns 401 for a normal session user without scheduler auth', async () => {
      const res = await t.requestAs('user-1').get('/api/scheduler/system/runs');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Scheduler auth required' });
    });
  });

  describe('GET /api/scheduler/system/runs', () => {
    test('returns active runs across tenants', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-a', path: '/a' });
      seedProject(t.db as any, { id: 'p2', userId: 'user-b', path: '/b' });
      seedThread(t.db as any, { id: 't-a', projectId: 'p1', userId: 'user-a' });
      seedThread(t.db as any, { id: 't-b', projectId: 'p2', userId: 'user-b' });
      seedSchedulerRun(t.db as any, { threadId: 't-a', userId: 'user-a' });
      seedSchedulerRun(t.db as any, { threadId: 't-b', userId: 'user-b' });

      const res = await app.request('/api/scheduler/system/runs', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runs).toHaveLength(2);
      expect(body.runs.map((r: { threadId: string }) => r.threadId).sort()).toEqual(['t-a', 't-b']);
    });
  });

  describe('GET /api/scheduler/system/dependencies', () => {
    test('returns dependency map for requested thread ids', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 'blocker', projectId: 'p1', userId: 'user-1' });
      seedThreadDependency(t.db as any, { threadId: 't1', blockedBy: 'blocker' });

      const res = await app.request('/api/scheduler/system/dependencies?threadIds=t1', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dependencies: { t1: ['blocker'] } });
    });
  });

  describe('POST /api/scheduler/system/dispatch', () => {
    /** The thread the scheduler dispatches, owned by `user-1`. */
    function seedOwnedThread() {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    }

    test('proxies to the thread owner runner and returns pipelineRunId', async () => {
      seedOwnedThread();
      seedRunner(t.db as any, {
        id: 'runner-1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });

      tunnelFetchImpl = async (_runnerId, req) => {
        expect(req.path).toBe('/api/scheduler/dispatch');
        expect(req.headers['X-Forwarded-User']).toBe('user-1');
        // Regression: the identity was forwarded unsigned, which the runtime
        // rejects with 401 — so every scheduler dispatch failed.
        expect(signedFor('user-1', req.headers)).toBe(true);
        expect(JSON.parse(req.body ?? '{}')).toEqual({
          threadId: 't1',
          prompt: 'go',
          pipelineName: 'fix-linear',
          inputs: { issue_id: 'GOL-123' },
        });
        return {
          status: 200,
          body: JSON.stringify({ pipelineRunId: 'pr-dispatch-1' }),
        };
      };

      const res = await app.request('/api/scheduler/system/dispatch', {
        method: 'POST',
        headers: {
          ...schedulerHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          threadId: 't1',
          userId: 'user-1',
          prompt: 'go',
          pipelineName: 'fix-linear',
          inputs: { issue_id: 'GOL-123' },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, pipelineRunId: 'pr-dispatch-1' });
    });

    test('returns 503 when no runner is connected for the thread owner', async () => {
      seedOwnedThread();
      const res = await app.request('/api/scheduler/system/dispatch', {
        method: 'POST',
        headers: {
          ...schedulerHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ threadId: 't1', userId: 'user-1' }),
      });

      expect(res.status).toBe(503);
      expect((await res.json()).ok).toBe(false);
    });

    test('returns 400 when threadId or userId is missing', async () => {
      const res = await app.request('/api/scheduler/system/dispatch', {
        method: 'POST',
        headers: {
          ...schedulerHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ threadId: 't1' }),
      });
      expect(res.status).toBe(400);
    });

    test('refuses a userId that does not own the thread, without contacting any runner', async () => {
      seedOwnedThread();
      seedRunner(t.db as any, { id: 'runner-1', userId: 'user-1', token: 'tr1', hostname: 'r1' });
      seedRunner(t.db as any, { id: 'runner-2', userId: 'user-2', token: 'tr2', hostname: 'r2' });
      tunnelFetchImpl = async () => {
        throw new Error('must not reach a runner');
      };
      const res = await app.request('/api/scheduler/system/dispatch', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't1', userId: 'user-2' }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).ok).toBe(false);
    });

    test('returns 404 for an unknown thread', async () => {
      const res = await app.request('/api/scheduler/system/dispatch', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'ghost', userId: 'user-1' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/scheduler/system/emit', () => {
    test('publishes events to the target user through BrowserEventSink', async () => {
      const res = await app.request('/api/scheduler/system/emit', {
        method: 'POST',
        headers: {
          ...schedulerHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'user-1',
          type: 'scheduler:tick',
          data: { tick: 1 },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(relayCalls).toHaveLength(1);
      expect(relayCalls[0]?.userId).toBe('user-1');
      expect(relayCalls[0]?.event.type).toBe('scheduler:tick');
    });

    test('returns 400 when userId or type is missing', async () => {
      const res = await app.request('/api/scheduler/system/emit', {
        method: 'POST',
        headers: {
          ...schedulerHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: 'user-1' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/scheduler/system/candidates', () => {
    test('returns eligible thread candidates', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'backlog',
        status: 'idle',
        schedulerManaged: 1,
      });

      const res = await app.request('/api/scheduler/system/candidates', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threads.map((t: { id: string }) => t.id)).toContain('t1');
    });
  });

  describe('GET /api/scheduler/system/terminal-thread-ids', () => {
    test('returns terminal thread ids', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, {
        id: 't-done',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'done',
      });
      seedThread(t.db as any, {
        id: 't-run',
        projectId: 'p1',
        userId: 'user-1',
        stage: 'in_progress',
        status: 'running',
      });

      const res = await app.request('/api/scheduler/system/terminal-thread-ids', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ids).toContain('t-done');
      expect(body.ids).not.toContain('t-run');
    });
  });

  describe('GET /api/scheduler/system/threads/:id', () => {
    test('returns thread snapshot by id', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Hello' });

      const res = await app.request('/api/scheduler/system/threads/t1', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).thread?.id).toBe('t1');
    });
  });

  describe('GET /api/scheduler/system/runs/:threadId', () => {
    test('returns a single active run', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedSchedulerRun(t.db as any, { threadId: 't1', userId: 'user-1' });

      const res = await app.request('/api/scheduler/system/runs/t1', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).run?.threadId).toBe('t1');
    });

    test('returns null run when thread is not claimed', async () => {
      const res = await app.request('/api/scheduler/system/runs/unclaimed', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).run).toBeNull();
    });
  });

  describe('GET /api/scheduler/system/runs/due-retries', () => {
    test('returns 400 for invalid now query', async () => {
      const res = await app.request('/api/scheduler/system/runs/due-retries?now=bad', {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(400);
    });

    test('returns due retry runs', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't-retry', projectId: 'p1', userId: 'user-1' });
      const past = Date.now() - 60_000;
      t.db
        .insert(t.schema.schedulerRuns)
        .values({
          threadId: 't-retry',
          userId: 'user-1',
          attempt: 1,
          nextRetryAtMs: past,
          lastEventAtMs: past,
          claimedAtMs: past,
          updatedAtMs: past,
          tokensTotal: 0,
          pipelineRunId: null,
          lastError: 'boom',
        })
        .run();

      const res = await app.request(`/api/scheduler/system/runs/due-retries?now=${Date.now()}`, {
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs.some((r: { threadId: string }) => r.threadId === 't-retry')).toBe(true);
    });
  });

  describe('POST /api/scheduler/system/runs (claim)', () => {
    test('claims a run for a thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't-claim', projectId: 'p1', userId: 'user-1' });

      const res = await app.request('/api/scheduler/system/runs', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't-claim', userId: 'user-1' }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).run.threadId).toBe('t-claim');
    });

    test('returns 400 when threadId or userId is missing', async () => {
      const res = await app.request('/api/scheduler/system/runs', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't1' }),
      });
      expect(res.status).toBe(400);
    });

    test('returns 409 when run is already claimed', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't-dup', projectId: 'p1', userId: 'user-1' });
      seedSchedulerRun(t.db as any, { threadId: 't-dup', userId: 'user-1' });

      const res = await app.request('/api/scheduler/system/runs', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't-dup', userId: 'user-1' }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /api/scheduler/system/runs/:threadId', () => {
    test('releases a claimed run', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't-rel', projectId: 'p1', userId: 'user-1' });
      seedSchedulerRun(t.db as any, { threadId: 't-rel', userId: 'user-1' });

      const res = await app.request('/api/scheduler/system/runs/t-rel', {
        method: 'DELETE',
        headers: schedulerHeaders(),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
  });

  describe('PATCH /api/scheduler/system/runs/:threadId', () => {
    test('updates pipelineRunId and retry metadata', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't-patch', projectId: 'p1', userId: 'user-1' });
      seedSchedulerRun(t.db as any, { threadId: 't-patch', userId: 'user-1' });

      const res = await app.request('/api/scheduler/system/runs/t-patch', {
        method: 'PATCH',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          setPipelineRunId: 'pr-123',
          setRetry: { attempt: 2, nextRetryAtMs: Date.now() + 5000, lastError: 'retry me' },
          touchLastEvent: Date.now(),
          addTokens: 42,
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await app.request('/api/scheduler/system/runs/t-patch', {
        headers: schedulerHeaders(),
      });
      const run = (await getRes.json()).run;
      expect(run.pipelineRunId).toBe('pr-123');
      expect(run.attempt).toBe(2);
      expect(run.tokensTotal).toBe(42);
    });

    test('returns 400 for invalid JSON body', async () => {
      const res = await app.request('/api/scheduler/system/runs/t-patch', {
        method: 'PATCH',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST/DELETE /api/scheduler/system/dependencies', () => {
    test('adds and removes a dependency edge', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedThread(t.db as any, { id: 'blocker', projectId: 'p1', userId: 'user-1' });

      const addRes = await app.request('/api/scheduler/system/dependencies', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't1', blockedBy: 'blocker' }),
      });
      expect(addRes.status).toBe(201);

      const listRes = await app.request('/api/scheduler/system/dependencies?threadIds=t1', {
        headers: schedulerHeaders(),
      });
      expect((await listRes.json()).dependencies.t1).toEqual(['blocker']);

      const delRes = await app.request('/api/scheduler/system/dependencies', {
        method: 'DELETE',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't1', blockedBy: 'blocker' }),
      });
      expect(delRes.status).toBe(200);
    });
  });

  describe('POST /api/scheduler/system/cancel/:pipelineRunId', () => {
    test('returns ok with found=false when user has no runner', async () => {
      const res = await app.request('/api/scheduler/system/cancel/pr-1', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, found: false });
    });

    test('proxies cancel to the user runner', async () => {
      seedRunner(t.db as any, {
        id: 'runner-1',
        userId: 'user-1',
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
      });

      tunnelFetchImpl = async (_runnerId, req) => {
        expect(req.path).toBe('/api/scheduler/cancel/pr-cancel-1');
        expect(signedFor('user-1', req.headers)).toBe(true);
        return { status: 200, body: null };
      };

      const res = await app.request('/api/scheduler/system/cancel/pr-cancel-1', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, found: true });
    });

    test("routes cancel to the run's project dedicated runner, not the general one", async () => {
      seedProject(t.db as any, { id: 'p-pinned', userId: 'user-1' });
      seedThread(t.db as any, { id: 't-pinned', projectId: 'p-pinned', userId: 'user-1' });
      seedPipeline(t.db as any, { id: 'pl-1', projectId: 'p-pinned', userId: 'user-1' });
      seedPipelineRun(t.db as any, { id: 'pr-pinned', pipelineId: 'pl-1', threadId: 't-pinned' });
      seedRunner(t.db as any, { id: 'laptop', userId: 'user-1', token: 'tl', hostname: 'l' });
      seedRunner(t.db as any, {
        id: 'rx',
        userId: 'user-1',
        token: 'tx',
        hostname: 'rx',
        role: 'dedicated',
      });
      __resetRunnerScopeCache();
      await setProjectDedicatedRunner('p-pinned', 'user-1', 'rx');

      const targets: string[] = [];
      tunnelFetchImpl = async (runnerId) => {
        targets.push(runnerId);
        return { status: 200, body: null };
      };
      const res = await app.request('/api/scheduler/system/cancel/pr-pinned', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      });
      expect(await res.json()).toEqual({ ok: true, found: true });
      expect(targets).toEqual(['rx']);
    });

    test("does not cancel another user's run", async () => {
      seedProject(t.db as any, { id: 'p-bob', userId: 'bob' });
      seedThread(t.db as any, { id: 't-bob', projectId: 'p-bob', userId: 'bob' });
      seedPipeline(t.db as any, { id: 'pl-bob', projectId: 'p-bob', userId: 'bob' });
      seedPipelineRun(t.db as any, { id: 'pr-bob', pipelineId: 'pl-bob', threadId: 't-bob' });
      seedRunner(t.db as any, { id: 'runner-1', userId: 'user-1', token: 'tr', hostname: 'r' });
      tunnelFetchImpl = async () => {
        throw new Error('must not reach a runner');
      };
      const res = await app.request('/api/scheduler/system/cancel/pr-bob', {
        method: 'POST',
        headers: { ...schedulerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      });
      expect(await res.json()).toEqual({ ok: true, found: false });
    });
  });
});
