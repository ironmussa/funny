/**
 * The server's request to remove a thread's workspace (track-funny-actions,
 * design D8) against the REAL runner resolution: it reaches only the owner's
 * runner for the thread; when that runner is offline the server records a
 * failed cleanup naming the directory and asks no other runner; when the
 * runner answered, the runner recorded it and the server records nothing.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';
process.env.BETTER_AUTH_SECRET = 'test-auth-secret';

const { RunnerGrpcSessionRegistry } = await import('../../services/grpc/session-registry.js');
const { __resetRunnerScopeCache } = await import('../../services/runner-scope.js');
const { requestScratchCleanup, requestThreadWorkspaceCleanup } =
  await import('../../services/thread-workspace-cleanup.js');
const { FakeRunnerRequestPort } = await import('../helpers/runner-port-fakes.js');
const { createTestDb, seedProject, seedRunner, seedRunnerProjectAssignment, seedThread } =
  await import('../helpers/test-db.js');
const { repos } = await import('../../db/repos.js');
const { createThreadsPort } = await import('../../trpc/ports/threads.js');
const { threads } = await import('../../db/schema.js');
const { eq } = await import('drizzle-orm');

let testDb: ReturnType<typeof createTestDb>;
let presence: InstanceType<typeof RunnerGrpcSessionRegistry>;
let requests: InstanceType<typeof FakeRunnerRequestPort>;

function runner(id: string, userId: string, online = true) {
  seedRunner(testDb.db, {
    id,
    userId,
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    role: 'general',
    status: online ? 'online' : 'offline',
  });
  seedRunnerProjectAssignment(testDb.db, { runnerId: id, projectId: 'p1' });
  if (online) {
    presence.activate(id, { invalidate: () => {} }, userId);
    requests.available.add(id);
  }
}

const ports = () => ({ requests, presence });

const THREAD = {
  id: 't1',
  projectId: 'p1',
  worktreePath: '/srv/wt/feature',
  branch: 'feature',
};

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  requests = new FakeRunnerRequestPort();
  __resetRunnerScopeCache();
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  // The archive records a stage transition; the shared test DB has no such table.
  testDb.sqlite.exec(
    'CREATE TABLE IF NOT EXISTS stage_history (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, changed_at TEXT NOT NULL)',
  );
  seedProject(testDb.db, { id: 'p1', userId: 'alice', path: '/srv/p1' });
  seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'alice', mode: 'worktree' });
});

describe('requestThreadWorkspaceCleanup', () => {
  test("sends the server row's path and branch to the owner's runner only", async () => {
    runner('r-bob', 'bob');
    runner('r-alice', 'alice');

    const result = await requestThreadWorkspaceCleanup(ports(), {
      userId: 'alice',
      thread: THREAD,
      deleteBranch: true,
      reason: 'thread-archived',
    });

    expect(result.isOk()).toBe(true);
    expect(requests.requests.map((r) => r.runnerId)).toEqual(['r-alice']);
    expect(requests.requests[0]!.request).toMatchObject({
      method: 'DELETE',
      path: '/api/worktrees',
    });
    expect(JSON.parse(String(requests.requests[0]!.request.body))).toEqual({
      projectId: 'p1',
      worktreePath: '/srv/wt/feature',
      branchName: 'feature',
      deleteBranch: true,
      reason: 'thread-archived',
      threadId: 't1',
    });
    expect(await repos.activities().listByUser('alice')).toHaveLength(0);
  });

  test('runner offline: a failed server cleanup names the directory, no other runner is asked', async () => {
    runner('r-alice', 'alice', false);
    runner('r-bob', 'bob');

    const result = await requestThreadWorkspaceCleanup(ports(), {
      userId: 'alice',
      thread: THREAD,
      deleteBranch: false,
      reason: 'thread-deleted',
    });

    expect(result.isErr()).toBe(true);
    expect(requests.requests).toEqual([]);
    const [activity] = await repos.activities().listByUser('alice');
    expect(activity).toMatchObject({
      kind: 'workspace.cleanup',
      status: 'failed',
      runnerId: null,
      origin: 'implicit',
      threadId: 't1',
      input: { reason: 'thread-deleted', branch: 'feature', deleteBranch: false },
    });
    expect(activity?.error).toContain('/srv/wt/feature');
  });

  test('the runner answered an error: it recorded the cleanup, the server records nothing', async () => {
    runner('r-alice', 'alice');
    requests.response = {
      status: 400,
      headers: {},
      body: JSON.stringify({ error: 'not a worktree of this project', activityRecorded: true }),
      bodyEncoding: 'utf8',
    };

    const result = await requestThreadWorkspaceCleanup(ports(), {
      userId: 'alice',
      thread: THREAD,
      deleteBranch: true,
      reason: 'thread-archived',
    });

    expect(result.isErr() && result.error).toContain('not a worktree');
    expect(await repos.activities().listByUser('alice')).toHaveLength(0);
  });
});

describe('a runner that refused before the cleanup ran', () => {
  test('the server records the failed cleanup itself', async () => {
    runner('r-alice', 'alice');
    requests.response = {
      status: 404,
      headers: {},
      body: JSON.stringify({ error: 'Project not found' }),
      bodyEncoding: 'utf8',
    };
    const result = await requestThreadWorkspaceCleanup(ports(), {
      userId: 'alice',
      thread: THREAD,
      deleteBranch: true,
      reason: 'thread-archived',
    });
    expect(result.isErr()).toBe(true);
    const [activity] = await repos.activities().listByUser('alice');
    expect(activity).toMatchObject({ kind: 'workspace.cleanup', status: 'failed', runnerId: null });
  });
});

describe('requestScratchCleanup', () => {
  test("sends the scratch route to the owner's runner", async () => {
    runner('r-alice', 'alice');
    const result = await requestScratchCleanup(ports(), { userId: 'alice', threadId: 's1' });
    expect(result.isOk()).toBe(true);
    expect(requests.requests[0]!.request).toMatchObject({
      method: 'DELETE',
      path: '/api/threads/s1/scratch',
    });
  });
});

describe('archiving a thread through the threads port (regression: archive left the worktree)', () => {
  function worktreeThread(id: string, extra: Record<string, unknown> = {}) {
    seedThread(testDb.db, {
      id,
      projectId: 'p1',
      userId: 'alice',
      status: 'completed',
      mode: 'worktree',
      branch: `feature-${id}`,
      worktreePath: `/srv/wt/${id}`,
      ...extra,
    });
  }

  async function archive(id: string) {
    const tasks: Array<() => Promise<void>> = [];
    const events: Array<Record<string, unknown>> = [];
    const port = createThreadsPort(
      { toUser: (_u: string, e: Record<string, unknown>) => events.push(e) } as never,
      { runnerPorts: ports(), background: (task) => tasks.push(task) },
    );
    const [row] = await testDb.db.select().from(threads).where(eq(threads.id, id));
    const thread = { ...row!, archived: !!row!.archived } as never;
    const answer = await port.update('alice', thread, { archived: true });
    await Promise.all(tasks.map((task) => task()));
    const [after] = await testDb.db.select().from(threads).where(eq(threads.id, id));
    return { answer, after: after!, events };
  }

  test("one DELETE /api/worktrees for the thread's worktree and branch, then the row forgets them", async () => {
    runner('r-alice', 'alice');
    worktreeThread('w1');

    const { answer, after, events } = await archive('w1');

    expect(answer.isOk()).toBe(true);
    const deletes = requests.requests.filter((r) => r.request.path === '/api/worktrees');
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String(deletes[0]!.request.body))).toMatchObject({
      worktreePath: '/srv/wt/w1',
      branchName: 'feature-w1',
      deleteBranch: true,
      reason: 'thread-archived',
    });
    expect(after).toMatchObject({ archived: 1, worktreePath: null, branch: null });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'thread:updated', threadId: 'w1' }),
    );
  });

  test('a local thread is archived without any request', async () => {
    runner('r-alice', 'alice');
    seedThread(testDb.db, { id: 'l1', projectId: 'p1', userId: 'alice', status: 'completed' });
    const { after } = await archive('l1');
    expect(after.archived).toBe(1);
    expect(requests.requests).toEqual([]);
  });

  test('a running thread keeps its worktree', async () => {
    runner('r-alice', 'alice');
    worktreeThread('r1', { status: 'running' });
    const { after } = await archive('r1');
    expect(requests.requests).toEqual([]);
    expect(after.worktreePath).toBe('/srv/wt/r1');
  });

  test('a thread unarchived before the cleanup started keeps its worktree', async () => {
    runner('r-alice', 'alice');
    worktreeThread('u1');
    const tasks: Array<() => Promise<void>> = [];
    const port = createThreadsPort(undefined, {
      runnerPorts: ports(),
      background: (task) => tasks.push(task),
    });
    const [row] = await testDb.db.select().from(threads).where(eq(threads.id, 'u1'));
    await port.update('alice', { ...row!, archived: false } as never, { archived: true });
    // Unarchived again before the background cleanup runs.
    await testDb.db.update(threads).set({ archived: 0 }).where(eq(threads.id, 'u1'));
    await Promise.all(tasks.map((task) => task()));
    expect(requests.requests).toEqual([]);
    const [after] = await testDb.db.select().from(threads).where(eq(threads.id, 'u1'));
    expect(after!.worktreePath).toBe('/srv/wt/u1');
  });

  test('a failed removal keeps the worktree on the row', async () => {
    runner('r-alice', 'alice');
    worktreeThread('f1');
    requests.response = { status: 500, headers: {}, body: '', bodyEncoding: 'utf8' };
    const { after } = await archive('f1');
    expect(after).toMatchObject({ archived: 1, worktreePath: '/srv/wt/f1', branch: 'feature-f1' });
  });

  test('runner offline: archived anyway, a failed cleanup is recorded', async () => {
    runner('r-alice', 'alice', false);
    worktreeThread('o1');
    const { answer, after } = await archive('o1');
    expect(answer.isOk()).toBe(true);
    expect(after.archived).toBe(1);
    expect(after.worktreePath).toBe('/srv/wt/o1');
    const [activity] = await repos.activities().listByUser('alice');
    expect(activity?.status).toBe('failed');
    expect(activity?.error).toContain('/srv/wt/o1');
  });
});
