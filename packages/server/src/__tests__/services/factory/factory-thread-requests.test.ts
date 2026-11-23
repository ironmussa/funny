/**
 * Requests to a factory run's threads against the REAL runner resolution
 * (`withRunnerFor`, `runners`, runner-scope): a follow-up and a stop reach the
 * enabler's own runner for the thread, never another user's; a refused
 * follow-up is an error; only running threads are stopped; and a follow-up to
 * a sandbox that slept is retried once after waking it for the enabler.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';
process.env.BETTER_AUTH_SECRET = 'test-auth-secret';

import { okAsync } from 'neverthrow';

const wakes: Array<[string, string]> = [];
mock.module('../../../services/thread-sandboxes/sandbox-lifecycle.js', () => ({
  sandboxWaker: () => ({
    wake: (threadId: string, ownerId: string) => {
      wakes.push([threadId, ownerId]);
      return okAsync('r-sandbox');
    },
  }),
}));

const { RunnerGrpcSessionRegistry } = await import('../../../services/grpc/session-registry.js');
const { __resetRunnerScopeCache } = await import('../../../services/runner-scope.js');
const { cleanupFactoryWorktrees, sendFactoryFollowUp, stopFactoryThreads } =
  await import('../../../services/factory/factory-thread-requests.js');
const { FakeRunnerRequestPort } = await import('../../helpers/runner-port-fakes.js');
const { createTestDb, seedProject, seedRunner, seedRunnerProjectAssignment, seedThread } =
  await import('../../helpers/test-db.js');
const { threads } = await import('../../../db/schema.js');
const { eq } = await import('drizzle-orm');

let testDb: ReturnType<typeof createTestDb>;
let presence: InstanceType<typeof RunnerGrpcSessionRegistry>;
let requests: InstanceType<typeof FakeRunnerRequestPort>;

function runner(id: string, userId: string) {
  seedRunner(testDb.db, {
    id,
    userId,
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    role: 'general',
    status: 'online',
  });
  seedRunnerProjectAssignment(testDb.db, { runnerId: id, projectId: 'p1' });
  presence.activate(id, { invalidate: () => {} }, userId);
  requests.available.add(id);
}

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  requests = new FakeRunnerRequestPort();
  wakes.length = 0;
  __resetRunnerScopeCache();
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice', path: '/srv/p1' });
});

const ports = () => ({ requests, presence });

describe('factory thread requests', () => {
  test("a follow-up reaches the enabler's own runner, never another user's", async () => {
    runner('r-bob', 'bob');
    runner('r-alice', 'alice');
    seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'alice', status: 'completed' });

    const sent = await sendFactoryFollowUp(ports(), 'alice', 't1', 'fix the CI');

    expect(sent.isOk()).toBe(true);
    expect(requests.requests.map((r) => r.runnerId)).toEqual(['r-alice']);
    expect(requests.requests[0]!.request).toMatchObject({
      method: 'POST',
      path: '/api/threads/t1/message',
    });
    expect(JSON.parse(String(requests.requests[0]!.request.body))).toEqual({
      content: 'fix the CI',
    });
  });

  test("a follow-up names the run's branch, and a refusal says why", async () => {
    runner('r-alice', 'alice');
    seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'alice', status: 'completed' });
    requests.response = {
      status: 409,
      headers: {},
      body: JSON.stringify({
        error: 'The thread\'s worktree is on branch "fix/x", not "factory/issue-7-r1"',
      }),
      bodyEncoding: 'utf8',
    };

    const sent = await sendFactoryFollowUp(ports(), 'alice', 't1', 'fix', 'factory/issue-7-r1');

    expect(JSON.parse(String(requests.requests[0]!.request.body))).toEqual({
      content: 'fix',
      expectedBranch: 'factory/issue-7-r1',
    });
    // The run parks with the runner's reason, not a bare status.
    expect(sent.isErr() && sent.error).toContain('409');
    expect(sent.isErr() && sent.error).toContain('"fix/x"');
  });

  test("another user's thread, or a refused follow-up, is an error", async () => {
    runner('r-alice', 'alice');
    seedThread(testDb.db, { id: 't-bob', projectId: 'p1', userId: 'bob', status: 'completed' });
    expect((await sendFactoryFollowUp(ports(), 'alice', 't-bob', 'x')).isErr()).toBe(true);

    seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'alice', status: 'completed' });
    requests.response = { status: 409, headers: {}, body: '', bodyEncoding: 'utf8' };
    const refused = await sendFactoryFollowUp(ports(), 'alice', 't1', 'x');
    expect(refused.isErr() && refused.error).toContain('409');
  });

  test('stopping a run stops only its threads still running', async () => {
    runner('r-alice', 'alice');
    seedThread(testDb.db, { id: 't-run', projectId: 'p1', userId: 'alice', status: 'running' });
    seedThread(testDb.db, { id: 't-done', projectId: 'p1', userId: 'alice', status: 'completed' });

    await stopFactoryThreads(ports(), 'alice', ['t-run', 't-done']);

    expect(requests.requests.map((r) => r.request.path)).toEqual(['/api/threads/t-run/stop']);
  });

  describe('cleaning up a merged run', () => {
    const worktreeThread = (id: string, extra: Record<string, unknown> = {}) =>
      seedThread(testDb.db, {
        id,
        projectId: 'p1',
        userId: 'alice',
        status: 'completed',
        mode: 'worktree',
        branch: `factory/issue-7-${id}`,
        worktreePath: `/srv/wt/${id}`,
        ...extra,
      });
    const row = async (id: string) =>
      (await testDb.db.select().from(threads).where(eq(threads.id, id)))[0]!;

    test("removes the worktree and its branch on the enabler's runner, then clears them", async () => {
      runner('r-bob', 'bob');
      runner('r-alice', 'alice');
      worktreeThread('t1');

      const events: Array<{ userId: string; event: Record<string, unknown> }> = [];
      await cleanupFactoryWorktrees(ports(), 'alice', ['t1', 't1'], {
        toUser: (userId, event) => events.push({ userId, event }),
      });

      expect(requests.requests.map((r) => r.runnerId)).toEqual(['r-alice']);
      expect(requests.requests[0]!.request).toMatchObject({
        method: 'DELETE',
        path: '/api/worktrees',
      });
      expect(JSON.parse(String(requests.requests[0]!.request.body))).toEqual({
        projectId: 'p1',
        worktreePath: '/srv/wt/t1',
        branchName: 'factory/issue-7-t1',
        deleteBranch: true,
        reason: 'factory-merged',
        threadId: 't1',
      });
      expect(await row('t1')).toMatchObject({ worktreePath: null, branch: null });
      expect(events).toEqual([
        {
          userId: 'alice',
          event: {
            type: 'thread:updated',
            threadId: 't1',
            data: { worktreePath: null, branch: null },
          },
        },
      ]);
    });

    test("leaves running, local, sandbox and other users' threads alone", async () => {
      runner('r-alice', 'alice');
      worktreeThread('t-run', { status: 'running' });
      worktreeThread('t-sb', { runtime: 'sandbox' });
      worktreeThread('t-bob', { userId: 'bob' });
      seedThread(testDb.db, { id: 't-local', projectId: 'p1', userId: 'alice', mode: 'local' });

      await cleanupFactoryWorktrees(ports(), 'alice', ['t-run', 't-sb', 't-bob', 't-local']);

      expect(requests.requests).toEqual([]);
      expect((await row('t-run')).worktreePath).toBe('/srv/wt/t-run');
    });

    // Issue #229: a run that ended without a pull request had 85 uncommitted
    // files in its worktree. The runner decides, and what it keeps stays recorded.
    test('keepUnsaved asks the runner to remove only an unchanged worktree', async () => {
      runner('r-alice', 'alice');
      worktreeThread('t1');
      requests.response = {
        status: 200,
        headers: {},
        body: JSON.stringify({ removed: false, dirtyFileCount: 85, unpushedCommitCount: 0 }),
        bodyEncoding: 'utf8',
      };
      const events: unknown[] = [];

      const kept = await cleanupFactoryWorktrees(
        ports(),
        'alice',
        ['t1'],
        { toUser: (_userId, event) => events.push(event) },
        { keepUnsaved: true },
      );

      expect(requests.requests[0]!.request).toMatchObject({
        method: 'POST',
        path: '/api/worktrees/remove-unchanged',
      });
      expect(kept).toEqual([
        { threadId: 't1', worktreePath: '/srv/wt/t1', dirtyFileCount: 85, unpushedCommitCount: 0 },
      ]);
      expect(events).toEqual([]);
      expect(await row('t1')).toMatchObject({
        worktreePath: '/srv/wt/t1',
        branch: 'factory/issue-7-t1',
      });
    });

    test('keepUnsaved clears the thread once the runner removed its unchanged worktree', async () => {
      runner('r-alice', 'alice');
      worktreeThread('t1');
      requests.response = {
        status: 200,
        headers: {},
        body: JSON.stringify({ removed: true }),
        bodyEncoding: 'utf8',
      };

      const kept = await cleanupFactoryWorktrees(ports(), 'alice', ['t1'], undefined, {
        keepUnsaved: true,
      });

      expect(kept).toEqual([]);
      expect(await row('t1')).toMatchObject({ worktreePath: null, branch: null });
    });

    test('keepUnsaved leaves the worktree when the runner does not know the route', async () => {
      runner('r-alice', 'alice');
      worktreeThread('t1');
      requests.response = { status: 404, headers: {}, body: '', bodyEncoding: 'utf8' };

      const kept = await cleanupFactoryWorktrees(ports(), 'alice', ['t1'], undefined, {
        keepUnsaved: true,
      });

      // Reported as kept, unchecked: the run must not end as "nothing left behind".
      expect(kept).toEqual([
        { threadId: 't1', worktreePath: '/srv/wt/t1', dirtyFileCount: 0, unpushedCommitCount: 0 },
      ]);
      expect((await row('t1')).worktreePath).toBe('/srv/wt/t1');
    });

    test('a runner that refuses keeps the worktree recorded on the thread', async () => {
      runner('r-alice', 'alice');
      worktreeThread('t1');
      requests.response = { status: 500, headers: {}, body: '', bodyEncoding: 'utf8' };
      const events: unknown[] = [];

      await cleanupFactoryWorktrees(ports(), 'alice', ['t1'], {
        toUser: (_userId, event) => events.push(event),
      });

      expect(events).toEqual([]);

      expect(await row('t1')).toMatchObject({
        worktreePath: '/srv/wt/t1',
        branch: 'factory/issue-7-t1',
      });
    });
  });

  test('a follow-up to a sleeping sandbox wakes it for the enabler and tries once more', async () => {
    seedThread(testDb.db, {
      id: 't-sb',
      projectId: 'p1',
      userId: 'alice',
      status: 'completed',
      runtime: 'sandbox',
    });

    const sent = await sendFactoryFollowUp(ports(), 'alice', 't-sb', 'fix');

    expect(wakes).toEqual([['t-sb', 'alice']]);
    // Still no sandbox runner online here: the retry fails too, and nothing
    // was sent to any other runner.
    expect(sent.isErr()).toBe(true);
    expect(requests.requests).toEqual([]);
  });
});
