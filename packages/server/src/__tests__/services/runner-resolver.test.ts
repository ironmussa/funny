/**
 * Integration tests for runner-resolver.ts — the security-critical path that
 * routes proxied requests to the requesting user's runner only.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import {
  resolveRunner as resolveRunnerWithPresence,
  resolveAnyRunner as resolveAnyRunnerWithPresence,
  cacheThreadRunner,
  uncacheThread,
  evictRunnerFromCache,
} from '../../services/runner-resolver.js';
import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
  seedThread,
} from '../helpers/test-db.js';

const RUNNER_IDS = ['r-a', 'r-b', 'r-other'] as const;

let testDb: ReturnType<typeof createTestDb>;
let presence: RunnerGrpcSessionRegistry;

const resolveRunner = (path: string, query: Record<string, string>, userId?: string) =>
  resolveRunnerWithPresence(path, query, userId, presence);
const resolveAnyRunner = () => resolveAnyRunnerWithPresence(presence);

async function bindTestDb() {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
}

function wireRunner(runnerId: string, userId: string) {
  seedRunner(testDb.db, {
    id: runnerId,
    userId,
    httpUrl: null,
    token: `tok-${runnerId}`,
  });
  presence.activate(runnerId, { invalidate: () => {} }, userId);
}

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  uncacheThread('t-a');
  uncacheThread('t-b');
  uncacheThread('t-shared');
  await bindTestDb();
});

afterEach(async () => {
  presence.closeAll();
  testDb.sqlite.close();
  const { closeDatabase, resetDatabaseForTests } = await import('../../db/index.js');
  await closeDatabase().catch(() => {});
  resetDatabaseForTests();
});

describe('resolveRunner — user isolation', () => {
  test('returns the user’s gRPC-connected runner (strategy 4)', async () => {
    wireRunner('r-a', 'user-a');

    const resolved = await resolveRunner('/api/browse', {}, 'user-a');

    expect(resolved).toEqual({ runnerId: 'r-a' });
  });

  test('does not return another user’s runner for the same project path', async () => {
    seedProject(testDb.db, { id: 'p1', userId: 'user-a' });
    wireRunner('r-a', 'user-a');
    wireRunner('r-b', 'user-b');
    seedRunnerProjectAssignment(testDb.db, {
      runnerId: 'r-a',
      projectId: 'p1',
      localPath: '/repo',
    });

    const resolved = await resolveRunner('/api/projects/p1/threads', {}, 'user-b');

    expect(resolved?.runnerId).toBe('r-b');
    expect(resolved?.runnerId).not.toBe('r-a');
  });

  test('scopes thread registry lookup to the requesting user', async () => {
    seedProject(testDb.db, { id: 'p1', userId: 'user-a' });
    wireRunner('r-a', 'user-a');
    wireRunner('r-b', 'user-b');
    seedThread(testDb.db, {
      id: 't-a',
      projectId: 'p1',
      userId: 'user-a',
      runnerId: 'r-a',
    });

    const denied = await resolveRunner('/api/threads/t-a/messages', {}, 'user-b');
    expect(denied?.runnerId).toBe('r-b');

    const allowed = await resolveRunner('/api/threads/t-a/messages', {}, 'user-a');
    expect(allowed?.runnerId).toBe('r-a');
  });

  test('prefers project assignment for the requesting user (strategy 2)', async () => {
    seedProject(testDb.db, { id: 'p1', userId: 'user-a' });
    wireRunner('r-a', 'user-a');
    wireRunner('r-other', 'user-a');
    seedRunnerProjectAssignment(testDb.db, {
      runnerId: 'r-other',
      projectId: 'p1',
      localPath: '/repo',
    });

    const resolved = await resolveRunner('/api/projects/p1/branches', {}, 'user-a');

    expect(resolved?.runnerId).toBe('r-other');
  });

  test('returns null when the user has no reachable runner', async () => {
    seedRunner(testDb.db, {
      id: 'r-offline',
      userId: 'user-a',
      httpUrl: null,
      token: 'tok-off',
    });

    const resolved = await resolveRunner('/api/browse', {}, 'user-a');
    expect(resolved).toBeNull();
  });

  test('does not fall back to httpUrl without a gRPC session', async () => {
    seedRunner(testDb.db, {
      id: 'r-http',
      userId: 'user-a',
      httpUrl: 'http://runner-http:3002',
      token: 'tok-http',
    });

    const resolved = await resolveRunner('/api/browse', {}, 'user-a');
    expect(resolved).toBeNull();
  });
});

describe('resolveRunner — cache', () => {
  test('uses cached thread mapping when runner is still reachable', async () => {
    presence.activate('r-a', { invalidate: () => {} }, 'user-a');
    cacheThreadRunner('t-shared', 'user-a', 'r-a');

    const resolved = await resolveRunner('/api/threads/t-shared/messages', {}, 'user-a');
    expect(resolved).toEqual({ runnerId: 'r-a' });
  });

  test('does not use another user’s cached thread mapping', async () => {
    cacheThreadRunner('t-shared', 'user-a', 'r-a');
    wireRunner('r-b', 'user-b');

    const resolved = await resolveRunner('/api/threads/t-shared/messages', {}, 'user-b');

    expect(resolved?.runnerId).toBe('r-b');
    expect(resolved?.runnerId).not.toBe('r-a');
  });

  test('evicts stale cache when runner disconnects', async () => {
    wireRunner('r-a', 'user-a');
    cacheThreadRunner('t-shared', 'user-a', 'r-a');
    presence.deactivate('r-a', presence.activeEpoch('r-a')!);

    wireRunner('r-b', 'user-b');

    const resolved = await resolveRunner('/api/threads/t-shared/messages', {}, 'user-b');
    expect(resolved?.runnerId).toBe('r-b');
  });

  test('uncacheThread and evictRunnerFromCache clear entries', async () => {
    cacheThreadRunner('t1', 'user-a', 'r-a');
    cacheThreadRunner('t2', 'user-a', 'r-a');
    cacheThreadRunner('t3', 'user-b', 'r-b');

    uncacheThread('t1');
    evictRunnerFromCache('r-a');

    expect(await resolveRunner('/api/threads/t1/messages', {}, 'user-a')).toBeNull();

    const t3 = await resolveRunner('/api/threads/t3/messages', {}, 'user-b');
    expect(t3).toBeNull();
  });
});

describe('resolveAnyRunner', () => {
  test('returns any gRPC-connected runner', async () => {
    wireRunner('r-a', 'user-a');

    const resolved = await resolveAnyRunner();
    expect(resolved?.runnerId).toBe('r-a');
  });

  test('returns null when no runner is reachable', async () => {
    seedRunner(testDb.db, {
      id: 'r-offline',
      userId: 'user-a',
      httpUrl: null,
      token: 'tok-off',
    });

    expect(await resolveAnyRunner()).toBeNull();
  });
});
