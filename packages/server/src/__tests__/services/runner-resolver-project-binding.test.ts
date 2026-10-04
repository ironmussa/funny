/**
 * Routing under project-runner-binding: pinned projects never fall back,
 * projectless work only lands on general runners, and unauthenticated
 * callbacks never reach a dedicated runner.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import { findAnyRunnerForUser, findRunnerForProject } from '../../services/runner-manager.js';
import {
  explainUnresolved,
  resolveAnyRunner,
  resolveRunner,
  uncacheThread,
} from '../../services/runner-resolver.js';
import {
  __resetRunnerScopeCache,
  grantProjectRunner,
  setProjectDedicatedRunner,
} from '../../services/runner-scope.js';
import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
  seedThread,
} from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let presence: RunnerGrpcSessionRegistry;

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

function runner(id: string, role: 'general' | 'dedicated', online = true, userId = 'alice') {
  seedRunner(testDb.db, {
    id,
    userId,
    role,
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    status: online ? 'online' : 'offline',
  });
  if (online) presence.activate(id, { invalidate: () => {} }, userId);
}

const resolve = (path: string, query: Record<string, string> = {}, userId = 'alice') =>
  resolveRunner(path, query, userId, presence);

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  __resetRunnerScopeCache();
  for (const t of ['t-x', 't-y', 't-scratch']) uncacheThread(t);
  await bindTestDb();
  seedProject(testDb.db, { id: 'px', userId: 'alice', path: '/home/alice/x' });
  seedProject(testDb.db, { id: 'py', userId: 'alice', path: '/home/alice/y' });
  seedThread(testDb.db, { id: 't-x', projectId: 'px', userId: 'alice' });
  seedThread(testDb.db, { id: 't-y', projectId: 'py', userId: 'alice' });
});

describe('pinned project', () => {
  test('routes only to its dedicated runner', async () => {
    runner('laptop', 'general');
    runner('rx', 'dedicated');
    seedRunnerProjectAssignment(testDb.db, { runnerId: 'laptop', projectId: 'px' });
    await setProjectDedicatedRunner('px', 'alice', 'rx');

    expect(await resolve('/api/threads/t-x/message')).toEqual({ runnerId: 'rx' });
    expect(await resolve('/api/projects/px/branches')).toEqual({ runnerId: 'rx' });
    // Other projects keep using the general runner, never the dedicated one.
    expect(await resolve('/api/threads/t-y/message')).toEqual({ runnerId: 'laptop' });
  });

  test('dedicated runner offline → no fallback to the general runner', async () => {
    runner('laptop', 'general');
    runner('rx', 'dedicated', false);
    seedRunnerProjectAssignment(testDb.db, { runnerId: 'laptop', projectId: 'px' });
    await setProjectDedicatedRunner('px', 'alice', 'rx');

    expect(await resolve('/api/threads/t-x/message')).toBeNull();
    expect(await resolve('/api/projects/px/branches')).toBeNull();
    expect(await explainUnresolved('/api/threads/t-x/message', {}, 'alice')).toBe(
      'project-runner-offline',
    );
    expect(await findRunnerForProject('px', 'alice')).toBeNull();
  });

  test('granted runner serves when the dedicated one is down', async () => {
    runner('rx', 'dedicated', false);
    runner('rx2', 'dedicated');
    await setProjectDedicatedRunner('px', 'alice', 'rx');
    await grantProjectRunner('px', 'alice', 'rx2');
    expect(await resolve('/api/threads/t-x/message')).toEqual({ runnerId: 'rx2' });
  });

  test('findRunnerForProject uses the pinned runner and the project path until it reports a checkout', async () => {
    runner('laptop', 'general');
    runner('rx', 'dedicated');
    seedRunnerProjectAssignment(testDb.db, {
      runnerId: 'laptop',
      projectId: 'px',
      localPath: '/home/alice/x',
    });
    await setProjectDedicatedRunner('px', 'alice', 'rx');
    const found = await findRunnerForProject('px', 'alice');
    expect(found?.runner.runnerId).toBe('rx');
    expect(found?.localPath).toBe('/home/alice/x');
  });
});

describe('dedicated runners stay inside their scope', () => {
  test('a dedicated runner never serves another project, even when it is the only one online', async () => {
    runner('laptop', 'general', false);
    runner('rx', 'dedicated');
    await setProjectDedicatedRunner('px', 'alice', 'rx');
    expect(await resolve('/api/threads/t-y/message')).toBeNull();
    expect(await explainUnresolved('/api/threads/t-y/message', {}, 'alice')).toBe(
      'general-runner-offline',
    );
    expect(await findRunnerForProject('py', 'alice')).toBeNull();
  });

  test('projectless work only lands on general runners', async () => {
    runner('rx', 'dedicated');
    seedThread(testDb.db, {
      id: 't-scratch',
      projectId: null as any,
      userId: 'alice',
      isScratch: 1,
    } as any);
    expect(await resolve('/api/browse/list')).toBeNull();
    expect(await resolve('/api/threads/t-scratch/message')).toBeNull();
    expect(await findAnyRunnerForUser('alice')).toBeNull();

    runner('laptop', 'general');
    expect(await resolve('/api/browse/list')).toEqual({ runnerId: 'laptop' });
    expect(await resolve('/api/threads/t-scratch/message')).toEqual({ runnerId: 'laptop' });
    expect(await findAnyRunnerForUser('alice')).toBe('laptop');
  });

  test('unauthenticated callbacks never reach a dedicated runner', async () => {
    runner('rx', 'dedicated');
    expect(await resolveAnyRunner(presence)).toBeNull();
    runner('laptop', 'general');
    expect(await resolveAnyRunner(presence)).toEqual({ runnerId: 'laptop' });
  });
});

describe('cache invalidation', () => {
  test('pinning a project re-routes a cached thread immediately', async () => {
    runner('laptop', 'general');
    runner('rx', 'dedicated');
    expect(await resolve('/api/threads/t-x/message')).toEqual({ runnerId: 'laptop' });
    await setProjectDedicatedRunner('px', 'alice', 'rx');
    expect(await resolve('/api/threads/t-x/message')).toEqual({ runnerId: 'rx' });
  });
});
