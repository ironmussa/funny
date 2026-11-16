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
const { sendFactoryFollowUp, stopFactoryThreads } = await import(
  '../../../services/factory/factory-thread-requests.js'
);
const { FakeRunnerRequestPort } = await import('../../helpers/runner-port-fakes.js');
const { createTestDb, seedProject, seedRunner, seedRunnerProjectAssignment, seedThread } =
  await import('../../helpers/test-db.js');

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
    db: testDb.db as any,
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
