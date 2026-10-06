/**
 * Infrastructure adapter tests for thread creation. Runner resolution runs
 * against a real in-memory DB and session registry, so isolation is checked
 * against production lookups and not against permissive mocks.
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
import { authenticatedUserId, resolvedRunnerId } from '../../../modules/threads/domain/ids.js';
import {
  threadRegistryAdapter,
  threadRoutingCacheAdapter,
} from '../../../modules/threads/infrastructure/registry-adapters.js';
import {
  createRemoteCreationAdapter,
  createRunnerResolutionAdapter,
} from '../../../modules/threads/infrastructure/runner-adapters.js';
import { RunnerGrpcSessionRegistry } from '../../../services/grpc/session-registry.js';
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
    const adapter = createRunnerResolutionAdapter(presence);
    expect(await adapter.resolve(alice, sharedProject, 'normal')).toBe(resolvedRunnerId('r-alice'));
    expect(await adapter.resolve(bob, sharedProject, 'idle')).toBe(resolvedRunnerId('r-bob'));
  });

  test('an available foreign runner is never selected for a project', async () => {
    runner('r-alice', 'alice', false);
    runner('r-bob', 'bob');
    const adapter = createRunnerResolutionAdapter(presence);
    expect(await adapter.resolve(alice, sharedProject, 'normal')).toBeNull();
  });

  test('an available foreign runner is never selected for scratch', async () => {
    runner('r-bob', 'bob');
    const adapter = createRunnerResolutionAdapter(presence);
    expect(await adapter.resolve(alice, scratch, 'normal')).toBeNull();
    expect(await adapter.resolve(bob, scratch, 'normal')).toBe(resolvedRunnerId('r-bob'));
  });
});

describe('remote creation adapter', () => {
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
    const result = await createRemoteCreationAdapter(t.port).create(
      resolvedRunnerId('r1'),
      alice,
      intent,
      { projectId: 'p', extra: true },
    );
    expect(result).toEqual({ ok: true, thread: { id: 't1' } });
    expect(t.calls[0][0]).toBe('r1');
    expect(t.calls[0][1]).toMatchObject({ method: 'POST', path });
    expect(JSON.parse(t.calls[0][1].body as string)).toEqual({ projectId: 'p', extra: true });
  });

  test('signs the authenticated actor identity', async () => {
    const t = transport();
    await createRemoteCreationAdapter(t.port).create(
      resolvedRunnerId('r1'),
      { userId: authenticatedUserId('alice'), organizationId: 'org-1', role: 'admin' },
      'normal',
      { userId: 'mallory' },
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
      await createRemoteCreationAdapter(t.port).create(resolvedRunnerId('r1'), alice, 'normal', {}),
    ).toEqual({ ok: false, status: 422, message: 'nope' });
  });

  test('throws on malformed success JSON and on a missing transport', async () => {
    const t = transport(201, '<html>');
    await expect(
      createRemoteCreationAdapter(t.port).create(resolvedRunnerId('r1'), alice, 'normal', {}),
    ).rejects.toThrow();
    await expect(
      createRemoteCreationAdapter(undefined).create(resolvedRunnerId('r1'), alice, 'normal', {}),
    ).rejects.toThrow();
  });
});

describe('registry and cache adapters (real thread registry)', () => {
  function useCaseWith(runnerId: string, thread: unknown) {
    return makeCreateThread({
      runners: { resolve: async () => resolvedRunnerId(runnerId) },
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
