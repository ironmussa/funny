/**
 * Characterization tests for POST /api/threads and POST /api/threads/idle.
 *
 * These pin the observable HTTP contract of thread creation (statuses, bodies,
 * forwarded payload, effect ordering) so the extraction into
 * `modules/threads` can be verified as behavior-preserving.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock, spyOn } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { SIGNATURE_HEADER } from '@funny/shared/auth/forwarded-identity';

import * as runnerManager from '../../services/runner-manager.js';
import type { RunnerRequest, RunnerResponse } from '../../services/runner-ports.js';
import * as runnerResolver from '../../services/runner-resolver.js';
import { __resetRunnerScopeCache } from '../../services/runner-scope.js';
import * as threadRegistry from '../../services/thread-registry.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner } from '../helpers/test-db.js';

const tunnelFetch = mock(
  async (_runnerId: string, _request: RunnerRequest): Promise<RunnerResponse> => ({
    status: 201,
    headers: {},
    body: JSON.stringify({ id: 't-new', title: 'Runtime title', branch: 'runtime/branch' }),
  }),
);

let runnerAvailable = true;

function respondWith(status: number, body: string) {
  tunnelFetch.mockImplementationOnce(async () => ({ status, headers: {}, body }));
}

function forwardedBody(call = 0): Record<string, unknown> {
  return JSON.parse(tunnelFetch.mock.calls[call][1].body as string);
}

describe('Thread creation — characterization', () => {
  let t: TestApp;
  const effects: string[] = [];

  beforeAll(async () => {
    t = await createTestApp({
      runnerPresence: {
        isAvailable: () => runnerAvailable,
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

  beforeEach(() => {
    t.cleanup();
    __resetRunnerScopeCache();
    runnerAvailable = true;
    effects.length = 0;
    // Resolution is mocked below, but the authorized sink still certifies the
    // chosen runner against `runners` and `runner-scope`, so the rows must exist.
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/p1' });
    seedRunner(t.db as any, { id: 'runner-1', userId: 'user-1', token: 'tok-1', hostname: 'r1' });
    seedRunner(t.db as any, { id: '__default__', userId: 'user-1', token: 'tok-d', hostname: 'd' });
    tunnelFetch.mockReset();
    tunnelFetch.mockImplementation(async () => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: 't-new', title: 'Runtime title', branch: 'runtime/branch' }),
    }));
    spyOn(runnerManager, 'findRunnerForProject').mockImplementation(async () => {
      effects.push('resolve');
      return { runner: { runnerId: 'runner-1' } } as any;
    });
    spyOn(runnerResolver, 'resolveRunnerDetailed').mockImplementation(async () => {
      effects.push('resolve');
      return { ok: true, runnerId: 'runner-1' };
    });
    spyOn(threadRegistry, 'registerThread').mockImplementation(async () => {
      effects.push('register');
    });
    spyOn(runnerResolver, 'cacheThreadRunner').mockImplementation(() => {
      effects.push('cache');
    });
  });

  afterEach(() => {
    mock.restore();
  });

  // ── 1.2: normalization, permissive payloads, precedence ─────────

  describe('normal and idle creation', () => {
    test('normal creation posts to /api/threads and returns the runner body with 201', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'Hello',
        prompt: 'Hi',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        id: 't-new',
        title: 'Runtime title',
        branch: 'runtime/branch',
      });
      expect(tunnelFetch.mock.calls[0][0]).toBe('runner-1');
      expect(tunnelFetch.mock.calls[0][1].path).toBe('/api/threads');
      expect(tunnelFetch.mock.calls[0][1].method).toBe('POST');
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
    });

    test('idle creation posts to /api/threads/idle with the same sequence', async () => {
      const res = await t.requestAs('user-1').post('/api/threads/idle', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(tunnelFetch.mock.calls[0][1].path).toBe('/api/threads/idle');
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
    });

    test('project payload (including unknown extension fields) is forwarded unchanged', async () => {
      const payload = {
        projectId: 'p1',
        title: 'T',
        prompt: 'P',
        mode: 'worktree',
        isScratch: false,
        customExtension: { nested: [1, 2] },
        userId: 'spoofed-user',
      };
      await t.requestAs('user-1').post('/api/threads', payload);
      expect(forwardedBody()).toEqual(payload);
    });

    test('actor identity comes from auth, not from body fields', async () => {
      await t.requestAs('user-1').post('/api/threads', { projectId: 'p1', userId: 'user-2' });
      const headers = tunnelFetch.mock.calls[0][1].headers;
      expect(headers['X-Forwarded-User']).toBe('user-1');
      expect(headers['X-Forwarded-Role']).toBe('user');
      expect(headers['X-Runner-Auth']).toBe('test-secret');
      expect(headers[SIGNATURE_HEADER]).toBeTruthy();
      expect(runnerManager.findRunnerForProject).toHaveBeenCalledWith('p1', 'user-1');
      expect((threadRegistry.registerThread as any).mock.calls[0][0].userId).toBe('user-1');
      expect(runnerResolver.cacheThreadRunner).toHaveBeenCalledWith('t-new', 'user-1', 'runner-1');
    });

    test('org headers are forwarded when present', async () => {
      await t.requestAs('user-1', 'admin', { orgId: 'org-1' }).post('/api/threads', {
        projectId: 'p1',
      });
      const headers = tunnelFetch.mock.calls[0][1].headers;
      expect(headers['X-Forwarded-Org']).toBe('org-1');
      expect(headers['X-Forwarded-Role']).toBe('admin');
    });
  });

  describe('scratch normalization', () => {
    test('scratch payload is normalized to projectId=null, mode=local before forwarding', async () => {
      await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        title: 'Scratch',
        extra: 'kept',
      });
      expect(forwardedBody()).toEqual({
        isScratch: true,
        title: 'Scratch',
        extra: 'kept',
        projectId: null,
        mode: 'local',
      });
      expect(runnerResolver.resolveRunnerDetailed).toHaveBeenCalledWith(
        '/api/threads',
        {},
        'user-1',
        expect.anything(),
      );
      expect(runnerManager.findRunnerForProject).not.toHaveBeenCalled();
      const entry = (threadRegistry.registerThread as any).mock.calls[0][0];
      expect(entry.projectId).toBeNull();
      expect(entry.isScratch).toBe(true);
      expect(entry.mode).toBe('local');
    });

    test('scratch idle creation resolves with the idle path', async () => {
      await t.requestAs('user-1').post('/api/threads/idle', { isScratch: true });
      expect((runnerResolver.resolveRunnerDetailed as any).mock.calls[0][0]).toBe(
        '/api/threads/idle',
      );
      expect(tunnelFetch.mock.calls[0][1].path).toBe('/api/threads/idle');
    });

    test('scratch with explicit null projectId and mode=local is accepted', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        projectId: null,
        mode: 'local',
      });
      expect(res.status).toBe(201);
    });

    test('scratch with a falsy mode is accepted and normalized to local', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', { isScratch: true, mode: '' });
      expect(res.status).toBe(201);
      expect(forwardedBody().mode).toBe('local');
    });

    test('only boolean true marks a scratch thread (string "true" is a project request)', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', { isScratch: 'true' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId is required' });
    });
  });

  describe('validation errors and precedence', () => {
    test('invalid JSON body returns 400 before any I/O', async () => {
      const res = await t.app.request('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': 'user-1' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
      expect(effects).toEqual([]);
    });

    test('scratch + projectId + non-local mode reports the project conflict first', async () => {
      const res = await t.requestAs('user-1').post('/api/threads', {
        isScratch: true,
        projectId: 'p1',
        mode: 'worktree',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Scratch threads cannot have a project',
        code: 'scratch-thread-cannot-have-project',
      });
      expect(effects).toEqual([]);
    });

    test('scratch + non-local mode returns the must-be-local error', async () => {
      const res = await t.requestAs('user-1').post('/api/threads/idle', {
        isScratch: true,
        mode: 'worktree',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Scratch threads must use mode = local',
        code: 'scratch-thread-must-be-local',
      });
      expect(effects).toEqual([]);
    });

    test('missing or empty projectId on a normal thread returns 400 without I/O', async () => {
      for (const body of [{}, { projectId: '' }, { projectId: null }]) {
        const res = await t.requestAs('user-1').post('/api/threads', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'projectId is required' });
      }
      expect(effects).toEqual([]);
    });
  });

  // ── 1.3: runners, responses, metadata, failures ─────────────────

  describe('runner resolution', () => {
    test('unavailable project runner falls back to the user-scoped resolver', async () => {
      runnerAvailable = false;
      await t.requestAs('user-1').post('/api/threads/idle', { projectId: 'p1' });
      expect(runnerResolver.resolveRunnerDetailed).toHaveBeenCalledWith(
        '/api/threads',
        { projectId: 'p1' },
        'user-1',
        expect.anything(),
      );
    });

    test('no project runner → 502 with project message, no remote call', async () => {
      (runnerManager.findRunnerForProject as any).mockResolvedValueOnce(null);
      (runnerResolver.resolveRunnerDetailed as any).mockResolvedValueOnce({
        ok: false,
        reason: 'general-runner-offline',
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'No runner connected. Check that your runner is online.',
        code: 'general-runner-offline',
      });
      expect(tunnelFetch).not.toHaveBeenCalled();
    });

    test('no scratch runner → 502 with user message', async () => {
      (runnerResolver.resolveRunnerDetailed as any).mockResolvedValueOnce({
        ok: false,
        reason: 'general-runner-offline',
      });
      const res = await t.requestAs('user-1').post('/api/threads', { isScratch: true });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'No runner connected. Check that your runner is online.',
        code: 'general-runner-offline',
      });
    });

    test('resolver exception is not converted into a creation failure (500)', async () => {
      (runnerManager.findRunnerForProject as any).mockImplementationOnce(async () => {
        throw new Error('db down');
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(500);
      expect(tunnelFetch).not.toHaveBeenCalled();
    });
  });

  describe('remote errors', () => {
    test('runner JSON error is forwarded with its status', async () => {
      respondWith(409, JSON.stringify({ error: 'branch exists' }));
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'branch exists' });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('runner plain-text error is forwarded as the message', async () => {
      respondWith(500, '  boom  ');
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'boom' });
    });

    test('runner empty error body uses the default message', async () => {
      respondWith(503, '');
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Runner request failed' });
    });

    test('3xx runner responses are treated as success', async () => {
      respondWith(304, JSON.stringify({ id: 't-3xx' }));
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
    });

    test('transport exception → 502 Thread creation failed', async () => {
      tunnelFetch.mockImplementationOnce(async () => {
        throw new Error('tunnel closed');
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread creation failed' });
    });

    test('malformed runner JSON → 502 Thread creation failed, nothing registered', async () => {
      respondWith(201, '<html>');
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread creation failed' });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('runner JSON null → 502 Thread creation failed', async () => {
      respondWith(201, 'null');
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
    });
  });

  describe('response metadata and registration', () => {
    test('top-level id is preferred over nested thread.id', async () => {
      respondWith(201, JSON.stringify({ id: 'top', thread: { id: 'nested' } }));
      await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect((threadRegistry.registerThread as any).mock.calls[0][0].id).toBe('top');
    });

    test('nested thread.id is used when top-level id is missing', async () => {
      respondWith(201, JSON.stringify({ thread: { id: 'nested' } }));
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ thread: { id: 'nested' } });
      expect((threadRegistry.registerThread as any).mock.calls[0][0].id).toBe('nested');
      expect(runnerResolver.cacheThreadRunner).toHaveBeenCalledWith('nested', 'user-1', 'runner-1');
    });

    test('missing id → 201 with body, no registration or cache', async () => {
      respondWith(201, JSON.stringify({ ok: true }));
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('registration entry: runtime branch wins, body title wins, typed fields only', async () => {
      respondWith(201, JSON.stringify({ id: 't1', title: 'Runtime', branch: 'rt/branch' }));
      await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: 'Body title',
        model: 'opus',
        mode: 'worktree',
        branch: 'body/branch',
      });
      expect((threadRegistry.registerThread as any).mock.calls[0][0]).toEqual({
        id: 't1',
        projectId: 'p1',
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'Body title',
        model: 'opus',
        mode: 'worktree',
        branch: 'rt/branch',
        isScratch: false,
      });
    });

    test('registration entry: falls back to runtime title and body branch; ignores non-strings', async () => {
      respondWith(201, JSON.stringify({ id: 't1', title: 'Runtime', branch: null }));
      await t.requestAs('user-1').post('/api/threads', {
        projectId: 'p1',
        title: '',
        model: 7,
        mode: false,
        branch: 'body/branch',
      });
      expect((threadRegistry.registerThread as any).mock.calls[0][0]).toEqual({
        id: 't1',
        projectId: 'p1',
        runnerId: 'runner-1',
        userId: 'user-1',
        title: 'Runtime',
        model: undefined,
        mode: undefined,
        branch: 'body/branch',
        isScratch: false,
      });
    });

    test('__default__ runner bypasses registration and cache', async () => {
      (runnerManager.findRunnerForProject as any).mockImplementationOnce(async () => {
        effects.push('resolve');
        return { runner: { runnerId: '__default__' } };
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(201);
      expect(tunnelFetch.mock.calls[0][0]).toBe('__default__');
      expect(effects).toEqual(['resolve', 'remote']);
    });

    test('registry failure after remote success → 502, cache skipped', async () => {
      (threadRegistry.registerThread as any).mockImplementationOnce(async () => {
        effects.push('register');
        throw new Error('constraint');
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Thread creation failed' });
      expect(effects).toEqual(['resolve', 'remote', 'register']);
      expect(tunnelFetch).toHaveBeenCalledTimes(1);
    });

    test('cache failure after registration → 502 Thread creation failed', async () => {
      (runnerResolver.cacheThreadRunner as any).mockImplementationOnce(() => {
        effects.push('cache');
        throw new Error('cache');
      });
      const res = await t.requestAs('user-1').post('/api/threads', { projectId: 'p1' });
      expect(res.status).toBe(502);
      expect(effects).toEqual(['resolve', 'remote', 'register', 'cache']);
      expect(tunnelFetch).toHaveBeenCalledTimes(1);
    });
  });
});
