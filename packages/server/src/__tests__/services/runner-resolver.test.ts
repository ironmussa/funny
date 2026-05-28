/**
 * Integration tests for runner-resolver.ts — the security-critical path that
 * routes proxied requests to the requesting user's runner only.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  resolveRunner,
  resolveAnyRunner,
  cacheThreadRunner,
  uncacheThread,
  evictRunnerFromCache,
} from '../../services/runner-resolver.js';
import { addRunnerClient, removeRunnerClient } from '../../services/ws-relay.js';
import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
  seedThread,
} from '../helpers/test-db.js';

const RUNNER_IDS = ['r-a', 'r-b', 'r-other'] as const;

let testDb: ReturnType<typeof createTestDb>;

async function bindTestDb() {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    close: () => testDb.sqlite.close(),
  });
}

function wireRunner(runnerId: string, userId: string, opts: { httpUrl?: string | null } = {}) {
  seedRunner(testDb.db, {
    id: runnerId,
    userId,
    httpUrl: opts.httpUrl ?? `http://${runnerId}.local:3002`,
    token: `tok-${runnerId}`,
  });
  addRunnerClient(runnerId, `sock-${runnerId}`, userId);
}

beforeEach(async () => {
  for (const id of RUNNER_IDS) removeRunnerClient(id);
  uncacheThread('t-a');
  uncacheThread('t-b');
  uncacheThread('t-shared');
  await bindTestDb();
});

afterEach(async () => {
  testDb.sqlite.close();
  const { closeDatabase, resetDatabaseForTests } = await import('../../db/index.js');
  await closeDatabase().catch(() => {});
  resetDatabaseForTests();
});

describe('resolveRunner — user isolation', () => {
  test('returns the user’s WS-connected runner (strategy 4)', async () => {
    wireRunner('r-a', 'user-a');

    const resolved = await resolveRunner('/api/browse', {}, 'user-a');

    expect(resolved).toEqual({ runnerId: 'r-a', httpUrl: 'http://r-a.local:3002' });
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

  test('falls back to httpUrl when WS is disconnected', async () => {
    seedRunner(testDb.db, {
      id: 'r-http',
      userId: 'user-a',
      httpUrl: 'http://runner-http:3002',
      token: 'tok-http',
    });

    const resolved = await resolveRunner('/api/browse', {}, 'user-a');
    expect(resolved).toEqual({ runnerId: 'r-http', httpUrl: 'http://runner-http:3002' });
  });
});

describe('resolveRunner — cache', () => {
  test('uses cached thread mapping when runner is still reachable', async () => {
    cacheThreadRunner('t-shared', 'r-a', 'http://cached.local');

    const resolved = await resolveRunner('/api/threads/t-shared/messages', {}, 'user-a');
    expect(resolved).toEqual({ runnerId: 'r-a', httpUrl: 'http://cached.local' });
  });

  test('evicts stale cache when runner disconnects', async () => {
    wireRunner('r-a', 'user-a');
    cacheThreadRunner('t-shared', 'r-a', null);
    removeRunnerClient('r-a');

    wireRunner('r-b', 'user-b');

    const resolved = await resolveRunner('/api/threads/t-shared/messages', {}, 'user-b');
    expect(resolved?.runnerId).toBe('r-b');
  });

  test('uncacheThread and evictRunnerFromCache clear entries', async () => {
    cacheThreadRunner('t1', 'r-a', null);
    cacheThreadRunner('t2', 'r-a', null);
    cacheThreadRunner('t3', 'r-b', null);

    uncacheThread('t1');
    evictRunnerFromCache('r-a');

    expect(await resolveRunner('/api/threads/t1/messages', {}, 'user-a')).toBeNull();

    const t3 = await resolveRunner('/api/threads/t3/messages', {}, 'user-b');
    expect(t3).toBeNull();
  });
});

describe('resolveAnyRunner', () => {
  test('returns any WS-connected runner', async () => {
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
