/**
 * Tests for server thread routes that proxy to runners (creation, fork,
 * fork-and-rewind, delete cleanup). The fork blocks are characterization
 * tests for `modularize-thread-fork`.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock, spyOn } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import type { RunnerRequest } from '../../services/runner-ports.js';

const tunnelFetch = mock(async (_runnerId: string, _request: RunnerRequest) => ({
  status: 201,
  headers: {},
  body: JSON.stringify({
    id: 't-forked',
    title: 'Forked thread',
    model: 'sonnet',
    mode: 'local',
    branch: 'feature/fork',
  }),
}));

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { eq } from 'drizzle-orm';

import * as ownershipProof from '../../modules/threads/domain/proofs/thread-owned-by.js';
import * as runnerManager from '../../services/runner-manager.js';
import * as runnerResolver from '../../services/runner-resolver.js';
import { __resetRunnerScopeCache } from '../../services/runner-scope.js';
import * as threadRegistry from '../../services/thread-registry.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedThread, seedResourceGrant } from '../helpers/test-db.js';

describe('Thread routes — runner proxy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      runnerPresence: {
        isAvailable: () => true,
        userHasAvailableRunner: () => true,
        userIdForRunner: () => 'user-1',
        availableRunnerCount: () => 1,
      },
      runnerRequests: {
        isAvailable: () => true,
        request: (runnerId, request) => {
          effects.push('remote');
          return tunnelFetch(runnerId, request);
        },
      },
    });
  });

  const resolvedRunner = {
    runnerId: 'runner-1',
    httpUrl: 'http://runner.local',
  };

  /** Effect order observed by the fork characterization tests. */
  const effects: string[] = [];

  beforeEach(() => {
    t.cleanup();
    __resetRunnerScopeCache();
    effects.length = 0;
    // Resolution is mocked below, but the authorized sink still certifies the
    // chosen runner against `runners` and `runner-scope`, so the rows must exist.
    seedRunner(t.db as any, { id: 'runner-1', userId: 'user-1', token: 'tok-1', hostname: 'r1' });
    seedRunner(t.db as any, { id: '__default__', userId: 'user-1', token: 'tok-d', hostname: 'd' });
    spyOn(threadRegistry, 'registerThread').mockImplementation(async () => {
      effects.push('register');
    });
    spyOn(runnerResolver, 'cacheThreadRunner').mockImplementation(() => {
      effects.push('cache');
    });
    spyOn(runnerManager, 'findRunnerForProject').mockImplementation(async () => {
      effects.push('resolve');
      return { runner: { runnerId: 'runner-1', httpUrl: 'http://runner.local' } } as any;
    });
    spyOn(runnerManager, 'findAnyRunnerForUser').mockResolvedValue(null);
    spyOn(runnerResolver, 'resolveRunnerDetailed').mockResolvedValue({
      ok: true,
      runnerId: resolvedRunner.runnerId,
    });
    (threadRegistry.registerThread as ReturnType<typeof mock>).mockClear();
    tunnelFetch.mockClear();
    tunnelFetch.mockImplementation(async () => ({
      status: 201,
      headers: {},
      body: JSON.stringify({
        id: 't-forked',
        title: 'Forked thread',
        model: 'sonnet',
        mode: 'local',
        branch: 'feature/fork',
      }),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  describe('POST /api/threads', () => {
    test('creates a project thread on the runner and registers it locally', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'New thread',
        prompt: 'Hello',
        model: 'sonnet',
        mode: 'local',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-forked');
      expect(tunnelFetch).toHaveBeenCalled();
      expect(threadRegistry.registerThread).toHaveBeenCalled();
    });

    test('returns 400 when projectId is missing for a normal thread', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        title: 'No project',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('returns 400 when scratch thread includes a projectId', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        projectId: 'p1',
        title: 'Bad scratch',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('scratch-thread-cannot-have-project');
    });

    test('returns 400 when scratch thread uses non-local mode', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        mode: 'worktree',
        title: 'Bad scratch',
        prompt: 'Hi',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('scratch-thread-must-be-local');
    });

    test('creates a scratch thread via any user runner', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 201,
        headers: {},
        body: JSON.stringify({
          id: 't-scratch-new',
          title: 'Scratch pad',
          model: 'sonnet',
          mode: 'local',
        }),
      }));

      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        title: 'Scratch pad',
        prompt: 'Try regex',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-scratch-new');
      expect(runnerResolver.resolveRunnerDetailed).toHaveBeenCalled();
    });

    test('returns 502 when no runner is available', async () => {
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      (runnerResolver.resolveRunnerDetailed as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: false,
        reason: 'general-runner-offline',
      });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'No runner',
        prompt: 'Hi',
      });
      expect(res.status).toBe(502);
    });

    test('forwards runner error status when tunnel responds with failure', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 422,
        headers: {},
        body: JSON.stringify({ error: 'invalid prompt' }),
      }));
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'Bad',
        prompt: 'Hi',
      });
      expect(res.status).toBe(422);
      expect(threadRegistry.registerThread).not.toHaveBeenCalled();
    });

    test('POST /api/threads/idle proxies to the idle runner path', async () => {
      let capturedPath = '';
      tunnelFetch.mockImplementationOnce(async (_runnerId, req) => {
        capturedPath = req.path;
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({ id: 't-idle', title: 'Idle', model: 'sonnet', mode: 'local' }),
        };
      });
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });

      const res = await t.requestAs('user-1').post('/api/threads/idle', {
        projectId: 'p1',
        title: 'Idle thread',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('t-idle');
      expect(capturedPath).toBe('/api/threads/idle');
    });
  });

  // ── Fork characterization (modularize-thread-fork, task 1.1) ──────
  //
  // These pin the HTTP contract of POST /:id/fork before its orchestration
  // moves into modules/threads: statuses, bodies, forwarded request, effect
  // order, registration fields, and runner isolation.

  function seedOwnedSource() {
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Source' });
  }

  function respondWith(status: number, body: string) {
    tunnelFetch.mockImplementationOnce(async () => ({ status, headers: {}, body }));
  }

  function registration(call = 0) {
    return (threadRegistry.registerThread as any).mock.calls[call][0];
  }

  /** POST with a hand-written body so byte-for-byte forwarding can be checked. */
  function postRaw(path: string, rawBody: string, orgId?: string) {
    return t.app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Test-User-Id': 'user-1',
        'X-Test-User-Role': 'user',
        ...(orgId ? { 'X-Test-Org-Id': orgId } : {}),
      },
      body: rawBody,
    });
  }

  for (const variant of ['fork', 'fork-and-rewind']) {
    for (const access of ['missing', 'stranger', 'viewer', 'steerer']) {
      test(`${variant} denies ${access} before all runner effects`, async () => {
        if (access !== 'missing') seedOwnedSource();
        if (access === 'viewer' || access === 'steerer') {
          seedResourceGrant(t.db as any, {
            subjectId: 'user-2',
            resourceId: 't1',
            role: access === 'steerer' ? 'contributor' : 'viewer',
          });
        }
        const res = await t.requestAs('user-2').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Thread not found' });
        expect(effects).toEqual([]);
        expect(tunnelFetch).not.toHaveBeenCalled();
        expect(threadRegistry.registerThread).not.toHaveBeenCalled();
        expect(runnerResolver.cacheThreadRunner).not.toHaveBeenCalled();
      });
    }
    test(`${variant} stops when proof issuance fails after middleware`, async () => {
      seedOwnedSource();
      spyOn(ownershipProof, 'threadOwnedBy').mockReturnValue(null);
      const res = await t.requestAs('user-1').post(`/api/threads/t1/${variant}`, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Thread not found' });
      expect(effects).toEqual([]);
    });
  }

  describe('POST /api/threads/:id/fork', () => {
    test('proxies fork to runner and returns new thread', async () => {
      seedOwnedSource();

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('t-forked');
      expect(tunnelFetch).toHaveBeenCalled();
    });

    test('returns the runner body verbatim and posts to the fork path on the actor runner', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify({ id: 't-forked', title: 'RT', extra: { nested: [1] } }));

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: 't-forked', title: 'RT', extra: { nested: [1] } });
      expect(tunnelFetch.mock.calls[0][0]).toBe('runner-1');
      expect(tunnelFetch.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        path: '/api/threads/t1/fork',
      });
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
      expect(runnerResolver.cacheThreadRunner).toHaveBeenCalledWith(
        't-forked',
        'user-1',
        'runner-1',
      );
    });

    test('a `null` runner body is returned as 201 null and nothing is registered', async () => {
      seedOwnedSource();
      respondWith(201, 'null');

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(201);
      expect(await res.json()).toBeNull();
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('a response without an id is returned but not registered', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify({ title: 'no id here' }));

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ title: 'no id here' });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('returns 404 for cross-tenant fork', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(404);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('returns 502 when no runner is available', async () => {
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      spyOn(runnerResolver, 'resolveRunnerDetailed').mockResolvedValueOnce({
        ok: false,
        reason: 'general-runner-offline',
      });
      seedOwnedSource();

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        anchorMessageId: 'm-anchor',
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'No runner connected. Check that your runner is online.',
        code: 'general-runner-offline',
      });
      expect(tunnelFetch).not.toHaveBeenCalled();
      expect(threadRegistry.registerThread).not.toHaveBeenCalled();
    });

    test('preserves runner error messages', async () => {
      tunnelFetch.mockImplementationOnce(async () => ({
        status: 400,
        headers: {},
        body: JSON.stringify({ error: 'Rewind is only available for Claude threads' }),
      }));
      seedOwnedSource();

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        messageId: 'm-anchor',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Rewind is only available for Claude threads' });
    });

    test('a non-JSON runner error body is forwarded as the message with the runner status', async () => {
      seedOwnedSource();
      respondWith(409, 'plain failure text');

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'plain failure text' });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('malformed success JSON → 502 Thread fork failed', async () => {
      seedOwnedSource();
      respondWith(201, '<html>not json');

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread fork failed' });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('registry failure after the runner succeeded → 502, cache skipped', async () => {
      seedOwnedSource();
      (threadRegistry.registerThread as any).mockImplementationOnce(async () => {
        effects.push('register');
        throw new Error('constraint');
      });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread fork failed' });
      expect(effects).toEqual(['resolve', 'remote', 'register']);
      expect(tunnelFetch).toHaveBeenCalledTimes(1);
    });

    test('__default__ runner skips registration and caching', async () => {
      seedOwnedSource();
      (runnerManager.findRunnerForProject as any).mockImplementationOnce(async () => {
        effects.push('resolve');
        return { runner: { runnerId: '__default__' } };
      });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      expect(res.status).toBe(201);
      expect(tunnelFetch.mock.calls[0][0]).toBe('__default__');
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('registration fields come from the runner response, project from the source', async () => {
      seedOwnedSource();
      respondWith(
        201,
        JSON.stringify({
          id: 't-forked',
          title: 'Runtime title',
          model: 'opus',
          mode: 'worktree',
          branch: 'rt/branch',
        }),
      );

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork', {
        messageId: 'm',
        title: 'Body title',
        model: 'haiku',
        mode: 'local',
        branch: 'body/branch',
      });
      expect(res.status).toBe(201);
      const entry = registration();
      expect(entry).toMatchObject({
        id: 't-forked',
        projectId: 'p1',
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'Runtime title',
        model: 'opus',
        mode: 'worktree',
        branch: 'rt/branch',
      });
      // Forks are never registered as scratch, whatever the source was.
      expect(Boolean(entry.isScratch)).toBe(false);
    });

    test('a null branch in the response is registered as undefined', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify({ id: 't-forked', branch: null }));

      await t.requestAs('user-1').post('/api/threads/t1/fork', { messageId: 'm' });
      const entry = registration();
      expect('branch' in entry ? entry.branch : undefined).toBeUndefined();
    });

    test('forwards the request body byte-for-byte without parsing it', async () => {
      seedOwnedSource();
      const raw = '{ "messageId" : "m-1" ,\n  "unknownField":[1, 2 ,3] }';

      const res = await postRaw('/api/threads/t1/fork', raw);
      expect(res.status).toBe(201);
      expect(tunnelFetch.mock.calls[0][1].body).toBe(raw);
    });

    test('forwards the signed authenticated actor identity', async () => {
      seedOwnedSource();

      const res = await postRaw('/api/threads/t1/fork', '{"messageId":"m"}', 'org-1');
      expect(res.status).toBe(201);
      const headers = tunnelFetch.mock.calls[0][1].headers;
      expect(headers['X-Forwarded-User']).toBe('user-1');
      expect(headers['X-Forwarded-Role']).toBe('user');
      expect(headers['X-Forwarded-Org']).toBe('org-1');
      expect(headers['X-Runner-Auth']).toBe('test-secret');
      expect(
        verifyForwardedIdentity(
          { userId: 'user-1', role: 'user', orgId: 'org-1', orgName: null },
          'test-secret',
          headers[SIGNATURE_HEADER],
          headers[TIMESTAMP_HEADER],
          headers[NONCE_HEADER],
        ),
      ).toBe(true);
    });
  });

  // ── Fork-and-rewind characterization (task 1.2) ───────────────────
  //
  // Same sequence as fork, with three pinned differences: the new thread is
  // nested under `thread`, the whole parsed body is returned, and runner
  // errors are formatted as `Runner error: <raw body>`.

  describe('POST /api/threads/:id/fork-and-rewind', () => {
    const rewound = {
      thread: {
        id: 't-rewound',
        title: 'Rewound',
        model: 'sonnet',
        mode: 'worktree',
        branch: 'rw/branch',
      },
      rewind: { commit: 'abc123', filesChanged: 2 },
    };

    test('returns the full parsed body and registers the nested thread', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify(rewound));

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
        title: 'Body title',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(rewound);
      expect(tunnelFetch.mock.calls[0][0]).toBe('runner-1');
      expect(tunnelFetch.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        path: '/api/threads/t1/fork-and-rewind',
      });
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
      const entry = registration();
      expect(entry).toMatchObject({
        id: 't-rewound',
        projectId: 'p1',
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'Rewound',
        model: 'sonnet',
        mode: 'worktree',
        branch: 'rw/branch',
      });
      expect(Boolean(entry.isScratch)).toBe(false);
      expect(runnerResolver.cacheThreadRunner).toHaveBeenCalledWith(
        't-rewound',
        'user-1',
        'runner-1',
      );
    });

    test('a `null` runner body is returned as 201 null and nothing is registered', async () => {
      seedOwnedSource();
      respondWith(201, 'null');

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toBeNull();
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('a body without a nested thread (or without an id) is returned but not registered', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify({ rewind: { commit: 'abc' } }));
      const first = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ rewind: { commit: 'abc' } });

      respondWith(201, JSON.stringify({ thread: { title: 'no id' } }));
      const second = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(second.status).toBe(201);
      expect(threadRegistry.registerThread).not.toHaveBeenCalled();
    });

    test('a top-level id (fork shape) is NOT registered for fork-and-rewind', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify({ id: 't-top-level' }));

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(201);
      expect(threadRegistry.registerThread).not.toHaveBeenCalled();
    });

    test('returns 404 for cross-tenant fork-and-rewind', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(404);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('returns 502 when no runner is available', async () => {
      (runnerManager.findRunnerForProject as ReturnType<typeof mock>).mockResolvedValueOnce(null);
      spyOn(runnerResolver, 'resolveRunnerDetailed').mockResolvedValueOnce({
        ok: false,
        reason: 'general-runner-offline',
      });
      seedOwnedSource();

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'No runner connected. Check that your runner is online.',
        code: 'general-runner-offline',
      });
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('runner errors are returned as `Runner error: <raw body>` with the runner status', async () => {
      seedOwnedSource();
      const rawError = JSON.stringify({ error: 'Rewind is only available for Claude threads' });
      respondWith(400, rawError);

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `Runner error: ${rawError}` });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('malformed success JSON → 502 Thread fork-and-rewind failed', async () => {
      seedOwnedSource();
      respondWith(201, '<html>not json');

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread fork-and-rewind failed' });
    });

    test('registry failure after the runner succeeded → 502, cache skipped', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify(rewound));
      (threadRegistry.registerThread as any).mockImplementationOnce(async () => {
        effects.push('register');
        throw new Error('constraint');
      });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread fork-and-rewind failed' });
      expect(effects).toEqual(['resolve', 'remote', 'register']);
    });

    test('__default__ runner skips registration and caching', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify(rewound));
      (runnerManager.findRunnerForProject as any).mockImplementationOnce(async () => {
        effects.push('resolve');
        return { runner: { runnerId: '__default__' } };
      });

      const res = await t.requestAs('user-1').post('/api/threads/t1/fork-and-rewind', {
        messageId: 'm',
      });
      expect(res.status).toBe(201);
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('forwards the raw body and the signed actor identity', async () => {
      seedOwnedSource();
      respondWith(201, JSON.stringify(rewound));
      const raw = '{ "messageId":"m-1",   "keep":true }';

      const res = await postRaw('/api/threads/t1/fork-and-rewind', raw, 'org-1');
      expect(res.status).toBe(201);
      const request = tunnelFetch.mock.calls[0][1];
      expect(request.body).toBe(raw);
      expect(request.headers['X-Forwarded-User']).toBe('user-1');
      expect(request.headers['X-Forwarded-Org']).toBe('org-1');
      expect(
        verifyForwardedIdentity(
          { userId: 'user-1', role: 'user', orgId: 'org-1', orgName: null },
          'test-secret',
          request.headers[SIGNATURE_HEADER],
          request.headers[TIMESTAMP_HEADER],
          request.headers[NONCE_HEADER],
        ),
      ).toBe(true);
    });
  });

  describe('DELETE /api/threads/:id — tenant isolation', () => {
    test('returns 404 when deleting another user thread', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-2', path: '/a' });
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await t.requestAs('user-1').delete('/api/threads/t1');
      expect(res.status).toBe(404);

      const row = await t.db
        .select()
        .from(t.schema.threads)
        .where(eq(t.schema.threads.id, 't1'))
        .get();
      expect(row).toBeTruthy();
    });
  });
});
