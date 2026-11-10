/**
 * thread-sandboxes isolation: a `sandbox` runner serves exactly one thread.
 * Requests for that thread go only to it (never a fallback), and it never
 * serves project-level work, projectless work or any other thread.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { assertRunnerDataScope, canRunnerActOnThread } from '../../services/data-scope.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import { explainUnresolved, resolveRunner, uncacheThread } from '../../services/runner-resolver.js';
import {
  __resetRunnerScopeCache,
  bindSandboxRunner,
  canRunnerAccessProject,
  canRunnerServeProjectless,
  evaluateRunnerAccess,
  grantProjectRunner,
  sandboxRunnerIdForThread,
  sandboxThreadOfRunner,
} from '../../services/runner-scope.js';
import { createTestDb, seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

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

function runner(id: string, online = true, userId = 'alice') {
  seedRunner(testDb.db, {
    id,
    userId,
    role: 'general',
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    status: online ? 'online' : 'offline',
  });
  if (online) presence.activate(id, { invalidate: () => {} }, userId);
}

const resolve = (path: string, query: Record<string, string> = {}) =>
  resolveRunner(path, query, 'alice', presence);

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  __resetRunnerScopeCache();
  for (const t of ['t-box', 't-other', 't-scratch', 't-failed-box']) uncacheThread(t);
  await bindTestDb();
  seedProject(testDb.db, { id: 'px', userId: 'alice', path: '/home/alice/x' });
  seedThread(testDb.db, { id: 't-box', projectId: 'px', userId: 'alice' });
  seedThread(testDb.db, { id: 't-other', projectId: 'px', userId: 'alice' });
});

describe('sandbox role rule', () => {
  test('a sandbox runner never serves a project, even when pinned or granted', () => {
    const sandbox = { id: 'r-box', userId: 'alice', role: 'sandbox' as const, threadId: 't-box' };
    expect(
      evaluateRunnerAccess(sandbox, {
        projectId: 'px',
        ownerId: 'alice',
        dedicatedRunnerId: 'r-box',
        grantedRunnerIds: ['r-box'],
      }),
    ).toBe(false);
  });

  test('binding records the thread on both sides', async () => {
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    expect(await sandboxThreadOfRunner('r-box')).toBe('t-box');
    expect(await sandboxRunnerIdForThread('t-box')).toBe('r-box');
    expect(await sandboxRunnerIdForThread('t-other')).toBeNull();
  });

  test('an explicit project grant does not widen a sandbox runner', async () => {
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    await grantProjectRunner('px', 'r-box', 'alice');
    expect(await canRunnerAccessProject('r-box', 'px')).toBe(false);
    expect(await canRunnerServeProjectless('r-box')).toBe(false);
  });
});

describe('routing', () => {
  test('a sandbox thread routes to its sandbox runner', async () => {
    runner('r-general');
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    expect((await resolve('/api/threads/t-box/message'))?.runnerId).toBe('r-box');
  });

  test('an offline sandbox never falls back to the general runner', async () => {
    runner('r-general');
    runner('r-box', false);
    await bindSandboxRunner('r-box', 't-box');
    expect(await resolve('/api/threads/t-box/message')).toBeNull();
    expect(await explainUnresolved('/api/threads/t-box/message', {}, 'alice')).toBe(
      'thread-sandbox-unavailable',
    );
  });

  test('a sandbox thread whose runner never registered never falls back to the general runner', async () => {
    // Its setup failed before the sandbox runner connected: the project's
    // runner holds a different checkout (the user's own working tree).
    runner('r-general');
    seedThread(testDb.db, {
      id: 't-failed-box',
      projectId: 'px',
      userId: 'alice',
      runtime: 'sandbox',
      status: 'failed',
    });
    for (const path of [
      '/api/threads/t-failed-box/message',
      '/api/git/t-failed-box/status',
      '/api/git/t-failed-box/diff/summary',
    ]) {
      expect(await resolve(path)).toBeNull();
      expect(await resolve(path, { projectId: 'px' })).toBeNull();
      expect(await explainUnresolved(path, {}, 'alice')).toBe('thread-sandbox-unavailable');
    }
  });

  test('other threads, project routes and projectless work never reach the sandbox', async () => {
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    expect(await resolve('/api/threads/t-other/message')).toBeNull();
    expect(await resolve('/api/projects/px/branches')).toBeNull();
    expect(await resolve('/api/browse/roots')).toBeNull();
  });

  test("a request made from a sandbox thread's view runs on its sandbox", async () => {
    runner('r-general');
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    const context = { threadId: 't-box' };
    expect((await resolve('/api/files/read', context))?.runnerId).toBe('r-box');
    expect((await resolve('/api/browse/files', context))?.runnerId).toBe('r-box');
    expect(
      (await resolve('/api/skills/resources', { ...context, projectId: 'px' }))?.runnerId,
    ).toBe('r-box');
    expect((await resolve('/api/git/project/px/remote-url', context))?.runnerId).toBe('r-box');
    // Without the thread context the same requests stay on the project's runner.
    expect((await resolve('/api/files/read'))?.runnerId).toBe('r-general');
  });

  test('a sandbox thread context never falls back to the local runner', async () => {
    runner('r-general');
    runner('r-box', false);
    await bindSandboxRunner('r-box', 't-box');
    expect(await resolve('/api/files/read', { threadId: 't-box' })).toBeNull();
    expect(await explainUnresolved('/api/files/read', { threadId: 't-box' }, 'alice')).toBe(
      'thread-sandbox-unavailable',
    );
  });

  test('a sandbox thread context whose runner never registered never falls back', async () => {
    runner('r-general');
    seedThread(testDb.db, {
      id: 't-failed-box',
      projectId: 'px',
      userId: 'alice',
      runtime: 'sandbox',
      status: 'failed',
    });
    expect(await resolve('/api/files/read', { threadId: 't-failed-box' })).toBeNull();
    expect(await explainUnresolved('/api/files/read', { threadId: 't-failed-box' }, 'alice')).toBe(
      'thread-sandbox-unavailable',
    );
  });

  test('a thread context only steers requests about its own project', async () => {
    runner('r-general');
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
    seedProject(testDb.db, { id: 'py', userId: 'alice', path: '/home/alice/y' });
    expect((await resolve('/api/projects/py/branches', { threadId: 't-box' }))?.runnerId).toBe(
      'r-general',
    );
    // A local thread's context keeps its project's runner.
    expect((await resolve('/api/files/read', { threadId: 't-other' }))?.runnerId).toBe('r-general');
  });

  test('binding a sandbox evicts a thread route cached on the general runner', async () => {
    runner('r-general');
    runner('r-box');
    expect((await resolve('/api/threads/t-box/message'))?.runnerId).toBe('r-general');
    await bindSandboxRunner('r-box', 't-box');
    expect((await resolve('/api/threads/t-box/message'))?.runnerId).toBe('r-box');
  });
});

describe('runner → server data channel', () => {
  beforeEach(async () => {
    runner('r-box');
    await bindSandboxRunner('r-box', 't-box');
  });

  test('a sandbox runner acts on its own thread only', async () => {
    expect(await canRunnerActOnThread('r-box', 'alice', 't-box')).toBe(true);
    expect(await canRunnerActOnThread('r-box', 'alice', 't-other')).toBe(false);
  });

  test('data for its thread is allowed, other threads and projects are refused', async () => {
    const own = await assertRunnerDataScope('r-box', {
      type: 'data:insert_message',
      payload: { threadId: 't-box' },
    });
    expect(own.ok).toBe(true);

    const other = await assertRunnerDataScope('r-box', {
      type: 'data:insert_message',
      payload: { threadId: 't-other' },
    });
    expect(other.ok).toBe(false);

    const foreignProject = await assertRunnerDataScope('r-box', {
      type: 'data:insert_message',
      payload: { threadId: 't-box', projectId: 'py' },
    });
    expect(foreignProject.ok).toBe(false);
  });

  test('projectless work and thread creation are refused', async () => {
    expect((await assertRunnerDataScope('r-box', { type: 'data:create_project' })).ok).toBe(false);
    const create = await assertRunnerDataScope('r-box', {
      type: 'data:create_thread',
      payload: { projectId: 'px' },
    });
    expect(create.ok).toBe(false);
  });
});
