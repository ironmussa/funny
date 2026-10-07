/**
 * Infrastructure adapter tests for thread creation and fork. Runner resolution
 * and certification run against a real in-memory DB and session registry
 * (through `services/runner-access`), so isolation is checked against
 * production lookups and not against permissive mocks.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';

import { makeCreateThread } from '../../../modules/threads/application/create-thread.js';
import type { ActorContext } from '../../../modules/threads/application/ports.js';
import type { CreationTarget } from '../../../modules/threads/domain/creation-target.js';
import {
  authenticatedUserId,
  authorizedThreadId,
  resolvedRunnerId,
} from '../../../modules/threads/domain/ids.js';
import {
  threadRegistryAdapter,
  threadRoutingCacheAdapter,
} from '../../../modules/threads/infrastructure/registry-adapters.js';
import {
  createRemoteCreationAdapter,
  createRemoteForkAdapter,
  createRunnerResolutionAdapter,
  createSourceRunnerResolutionAdapter,
} from '../../../modules/threads/infrastructure/runner-adapters.js';
import { RunnerGrpcSessionRegistry } from '../../../services/grpc/session-registry.js';
import { runnerAccess } from '../../../services/runner-access/index.js';
import type { RunnerRequest, RunnerRequestPort } from '../../../services/runner-ports.js';
import * as runnerResolver from '../../../services/runner-resolver.js';
import { __resetRunnerScopeCache } from '../../../services/runner-scope.js';
import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
} from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let presence: RunnerGrpcSessionRegistry;

const alice: ActorContext = { userId: authenticatedUserId('alice') };
const bob: ActorContext = { userId: authenticatedUserId('bob') };
const sharedProject: CreationTarget = { kind: 'project', projectId: 'p-shared' };
const scratch: CreationTarget = { kind: 'scratch', mode: 'local' };

const okRunner = (id: string) => ({ ok: true as const, runnerId: resolvedRunnerId(id) });
const noRunner = { ok: false as const, reason: 'general-runner-offline' as const };
const deps = (requests?: RunnerRequestPort) => ({ presence, requests, access: runnerAccess });

function runner(id: string, userId: string, online = true) {
  seedRunner(testDb.db, {
    id,
    userId,
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    status: online ? 'online' : 'offline',
  });
  seedRunnerProjectAssignment(testDb.db, { runnerId: id, projectId: 'p-shared' });
  if (online) presence.activate(id, { invalidate: () => {} }, userId);
}

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  __resetRunnerScopeCache();
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p-shared', userId: 'alice', path: '/srv/shared' });
});

afterEach(() => {
  mock.restore();
});

describe('runner resolution adapter (real resolver, two users)', () => {
  test('each actor gets their own runner for a shared project', async () => {
    runner('r-alice', 'alice');
    runner('r-bob', 'bob');
    const adapter = createRunnerResolutionAdapter(deps());
    expect(await adapter.resolve(alice, sharedProject, 'normal')).toEqual(okRunner('r-alice'));
    expect(await adapter.resolve(bob, sharedProject, 'idle')).toEqual(okRunner('r-bob'));
  });

  test('an available foreign runner is never selected for a project', async () => {
    runner('r-alice', 'alice', false);
    runner('r-bob', 'bob');
    const adapter = createRunnerResolutionAdapter(deps());
    expect(await adapter.resolve(alice, sharedProject, 'normal')).toEqual(noRunner);
  });

  test('an available foreign runner is never selected for scratch', async () => {
    runner('r-bob', 'bob');
    const adapter = createRunnerResolutionAdapter(deps());
    expect(await adapter.resolve(alice, scratch, 'normal')).toEqual(noRunner);
    expect(await adapter.resolve(bob, scratch, 'normal')).toEqual(okRunner('r-bob'));
  });
});

describe('remote creation adapter', () => {
  beforeEach(() => runner('r1', 'alice'));

  function transport(status = 201, body = '{"id":"t1"}') {
    const calls: Array<[string, RunnerRequest]> = [];
    const port: RunnerRequestPort = {
      isAvailable: () => true,
      request: async (runnerId, request) => {
        calls.push([runnerId, request]);
        return { status, headers: {}, body };
      },
    };
    return { port, calls };
  }

  test.each([
    ['normal', '/api/threads'],
    ['idle', '/api/threads/idle'],
  ] as const)('%s intent posts to %s with the payload', async (intent, path) => {
    const t = transport();
    const result = await createRemoteCreationAdapter(deps(t.port)).create(
      resolvedRunnerId('r1'),
      alice,
      intent,
      { projectId: 'p-shared', extra: true },
    );
    expect(result).toEqual({ ok: true, thread: { id: 't1' } });
    expect(t.calls[0][0]).toBe('r1');
    expect(t.calls[0][1]).toMatchObject({ method: 'POST', path });
    expect(JSON.parse(t.calls[0][1].body as string)).toEqual({
      projectId: 'p-shared',
      extra: true,
    });
  });

  test('signs the authenticated actor identity', async () => {
    const t = transport();
    await createRemoteCreationAdapter(deps(t.port)).create(
      resolvedRunnerId('r1'),
      { userId: authenticatedUserId('alice'), organizationId: 'org-1', role: 'admin' },
      'normal',
      { isScratch: true, userId: 'mallory' },
    );
    const headers = t.calls[0][1].headers;
    expect(headers['X-Forwarded-User']).toBe('alice');
    expect(headers['X-Forwarded-Org']).toBe('org-1');
    expect(
      verifyForwardedIdentity(
        { userId: 'alice', role: 'admin', orgId: 'org-1', orgName: null },
        'test-secret',
        headers[SIGNATURE_HEADER],
        headers[TIMESTAMP_HEADER],
        headers[NONCE_HEADER],
      ),
    ).toBe(true);
  });

  test('maps runner errors to a message', async () => {
    const t = transport(422, '{"error":"nope"}');
    expect(
      await createRemoteCreationAdapter(deps(t.port)).create(
        resolvedRunnerId('r1'),
        alice,
        'normal',
        { isScratch: true },
      ),
    ).toEqual({ ok: false, status: 422, message: 'nope' });
  });

  test('throws on malformed success JSON and on a missing transport', async () => {
    const t = transport(201, '<html>');
    await expect(
      createRemoteCreationAdapter(deps(t.port)).create(resolvedRunnerId('r1'), alice, 'normal', {
        isScratch: true,
      }),
    ).rejects.toThrow();
    await expect(
      createRemoteCreationAdapter(deps(undefined)).create(resolvedRunnerId('r1'), alice, 'normal', {
        isScratch: true,
      }),
    ).rejects.toThrow();
  });

  test("a runner that is not the actor's is refused before anything is sent", async () => {
    runner('r-bob', 'bob');
    const t = transport();
    await expect(
      createRemoteCreationAdapter(deps(t.port)).create(resolvedRunnerId('r-bob'), alice, 'normal', {
        projectId: 'p-shared',
      }),
    ).rejects.toThrow('certification');
    expect(t.calls).toEqual([]);
  });
});

describe('registry and cache adapters (real thread registry)', () => {
  function useCaseWith(runnerId: string, thread: unknown) {
    return makeCreateThread({
      runners: { resolve: async () => okRunner(runnerId) },
      remote: { create: async () => ({ ok: true, thread }) },
      registry: threadRegistryAdapter,
      routingCache: threadRoutingCacheAdapter,
    });
  }

  async function threadRow(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.threads)
      .all()
      .find((row: any) => row.id === id) as any;
  }

  test('persists registration metadata with the runtime branch winning', async () => {
    const cache = spyOn(runnerResolver, 'cacheThreadRunner');
    runner('r-alice', 'alice');
    const result = await useCaseWith('r-alice', { id: 't1', branch: 'rt/b', title: 'RT' })({
      actor: alice,
      intent: 'normal',
      payload: { projectId: 'p-shared', title: 'Body', model: 'opus', branch: 'body/b' },
    });
    expect(result.isOk()).toBe(true);
    expect(await threadRow('t1')).toMatchObject({
      projectId: 'p-shared',
      runnerId: 'r-alice',
      userId: 'alice',
      title: 'Body',
      model: 'opus',
      branch: 'rt/b',
      isScratch: 0,
    });
    expect(cache).toHaveBeenCalledWith('t1', 'alice', 'r-alice');
  });

  test('registers nested thread ids and scratch metadata', async () => {
    runner('r-alice', 'alice');
    await useCaseWith('r-alice', { thread: { id: 't-nested' } })({
      actor: alice,
      intent: 'idle',
      payload: { isScratch: true },
    });
    expect(await threadRow('t-nested')).toMatchObject({
      projectId: null,
      mode: 'local',
      isScratch: 1,
    });
  });

  test('default runner neither registers nor caches', async () => {
    const cache = spyOn(runnerResolver, 'cacheThreadRunner');
    await useCaseWith('__default__', { id: 't-default' })({
      actor: alice,
      intent: 'normal',
      payload: { projectId: 'p-shared' },
    });
    expect(await threadRow('t-default')).toBeUndefined();
    expect(cache).not.toHaveBeenCalled();
  });
});

describe('source runner resolution adapter (fork, real resolver, two users)', () => {
  test('each actor forks on their own runner for a shared project', async () => {
    runner('r-alice', 'alice');
    runner('r-bob', 'bob');
    const adapter = createSourceRunnerResolutionAdapter(deps());
    expect(await adapter.resolve(alice, 'p-shared')).toEqual(okRunner('r-alice'));
    expect(await adapter.resolve(bob, 'p-shared')).toEqual(okRunner('r-bob'));
  });

  test('an available foreign runner is never selected, even when the actor has none online', async () => {
    runner('r-alice', 'alice', false);
    runner('r-bob', 'bob');
    const adapter = createSourceRunnerResolutionAdapter(deps());
    expect(await adapter.resolve(alice, 'p-shared')).toEqual(noRunner);
  });
});

describe('remote fork adapter', () => {
  const sourceId = authorizedThreadId('t-source');
  beforeEach(() => runner('r1', 'alice'));

  function transport(status = 201, body = '{"id":"t-forked"}') {
    const calls: Array<[string, RunnerRequest]> = [];
    const port: RunnerRequestPort = {
      isAvailable: () => true,
      request: async (runnerId, request) => {
        calls.push([runnerId, request]);
        return { status, headers: {}, body };
      },
    };
    return { port, calls };
  }

  test.each([
    ['fork', '/api/threads/t-source/fork'],
    ['fork-and-rewind', '/api/threads/t-source/fork-and-rewind'],
  ] as const)('%s posts the raw body byte-for-byte to %s', async (variant, path) => {
    const t = transport();
    const raw = '{ "messageId" : "m" ,\n "unknown":[1,2] }';
    const result = await createRemoteForkAdapter(deps(t.port)).fork(
      resolvedRunnerId('r1'),
      alice,
      variant,
      sourceId,
      raw,
      'p-shared',
    );
    expect(result).toEqual({ ok: true, thread: { id: 't-forked' } });
    expect(t.calls[0][0]).toBe('r1');
    expect(t.calls[0][1]).toMatchObject({ method: 'POST', path, body: raw });
  });

  test('signs the authenticated actor identity', async () => {
    const t = transport();
    await createRemoteForkAdapter(deps(t.port)).fork(
      resolvedRunnerId('r1'),
      { userId: authenticatedUserId('alice'), organizationId: 'org-1', role: 'admin' },
      'fork',
      sourceId,
      '{"userId":"mallory"}',
      'p-shared',
    );
    const headers = t.calls[0][1].headers;
    expect(headers['X-Forwarded-User']).toBe('alice');
    expect(headers['X-Forwarded-Org']).toBe('org-1');
    expect(headers['X-Forwarded-Role']).toBe('admin');
    expect(
      verifyForwardedIdentity(
        { userId: 'alice', role: 'admin', orgId: 'org-1', orgName: null },
        'test-secret',
        headers[SIGNATURE_HEADER],
        headers[TIMESTAMP_HEADER],
        headers[NONCE_HEADER],
      ),
    ).toBe(true);
  });

  test('fork formats runner errors with runnerErrorMessage', async () => {
    const json = transport(400, '{"error":"Rewind is only available for Claude threads"}');
    expect(
      await createRemoteForkAdapter(deps(json.port)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork',
        sourceId,
        '{}',

        'p-shared',
      ),
    ).toEqual({ ok: false, status: 400, message: 'Rewind is only available for Claude threads' });

    const plain = transport(409, 'plain failure text');
    expect(
      await createRemoteForkAdapter(deps(plain.port)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork',
        sourceId,
        '{}',

        'p-shared',
      ),
    ).toEqual({ ok: false, status: 409, message: 'plain failure text' });
  });

  test('fork-and-rewind formats runner errors as `Runner error: <raw body>`', async () => {
    const raw = '{"error":"Rewind is only available for Claude threads"}';
    const t = transport(400, raw);
    expect(
      await createRemoteForkAdapter(deps(t.port)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork-and-rewind',
        sourceId,
        '{}',

        'p-shared',
      ),
    ).toEqual({ ok: false, status: 400, message: `Runner error: ${raw}` });
  });

  test('a null success body parses to null', async () => {
    const t = transport(201, 'null');
    expect(
      await createRemoteForkAdapter(deps(t.port)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork',
        sourceId,
        '{}',

        'p-shared',
      ),
    ).toEqual({ ok: true, thread: null });
  });

  test('throws on malformed success JSON and on a missing transport', async () => {
    const t = transport(201, '<html>');
    await expect(
      createRemoteForkAdapter(deps(t.port)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork',
        sourceId,
        '{}',
        'p-shared',
      ),
    ).rejects.toThrow();
    await expect(
      createRemoteForkAdapter(deps(undefined)).fork(
        resolvedRunnerId('r1'),
        alice,
        'fork',
        sourceId,
        '{}',

        'p-shared',
      ),
    ).rejects.toThrow();
  });
});
