/**
 * Issue factory watcher: scheduling, admission (dedup + concurrency), dispatch
 * to the enabler's runner, and terminal completion — fake GitHub + fake
 * launcher + fake poll, real test DB.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { err, ok, okAsync } from 'neverthrow';

import type { FactoryGithubPort, FactoryIssue } from '../../../services/factory/factory-github.js';
import { onFactoryThreadTerminal } from '../../../services/factory/factory-runs-completion.js';
import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  listEnabledFactories,
} from '../../../services/factory/factory-settings.js';
import {
  type CreatePoll,
  MAX_ATTEMPTS,
  scheduledFactoryCount,
  startFactoryWatcher,
  stopFactoryWatcher,
} from '../../../services/factory/factory-watcher.js';
import type { StartThreadInput } from '../../../services/runner-thread-launcher.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

const ports = { requests: {} as any };

/** Fake poll: captures each factory's tick so the test can fire it. */
function fakePoll() {
  const ticks: Array<() => Promise<void>> = [];
  const createPoll: CreatePoll = (onTick) => {
    ticks.push(onTick);
    return { stop: () => {} };
  };
  return { ticks, createPoll };
}

/** Fake launcher recording calls; succeeds with a thread id per call. */
function fakeLauncher(result: 'ok' | 'offline' = 'ok') {
  const calls: StartThreadInput[] = [];
  const launch = async (input: StartThreadInput) => {
    calls.push(input);
    return result === 'ok'
      ? ok({ thread: { id: `t-${calls.length}` }, threadId: `t-${calls.length}`, runnerId: 'r1' })
      : err({ kind: 'runner-unavailable' as const, status: 502 as const, message: 'offline' });
  };
  return { calls, launch: launch as any };
}

/** Fake GitHub side: a fixed repo and issue list. */
function fakeGithub(repo: string | null, issues: FactoryIssue[]): FactoryGithubPort {
  return {
    resolveRepo: async () => repo,
    listReadyIssues: () => okAsync(issues),
  };
}

const resolveRuntime = async () => 'local' as const;

async function enableFactory(opts: { label?: string; maxConcurrent?: number } = {}) {
  const settings = createFactorySettingsService();
  const saved = await settings.save('alice', 'p1', { enabled: true, ...opts });
  if (saved.isErr()) throw new Error(saved.error.message);
  const factoryId = await settings.factoryId('alice', 'p1');
  if (factoryId.isErr() || !factoryId.value) throw new Error('no factory id');
  return factoryId.value;
}

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
});

afterEach(() => stopFactoryWatcher());

describe('factory watcher', () => {
  test('schedules only enabled factories', async () => {
    await enableFactory();
    // A disabled factory for another project is not scheduled.
    seedProject(testDb.db, { id: 'p2', userId: 'alice', path: '/repo2' });
    await createFactorySettingsService().save('alice', 'p2', { enabled: false });

    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: fakePoll().createPoll,
    });

    expect(scheduledFactoryCount()).toBe(1);
    expect((await listEnabledFactories()).map((f) => f.projectId)).toEqual(['p1']);
  });

  test('a tick admits an open issue and starts an implement run for the enabler', async () => {
    const factoryId = await enableFactory({ label: 'ready-for-agent' });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]!.userId).toBe('alice');
    expect(launcher.calls[0]!.body).toMatchObject({
      projectId: 'p1',
      mode: 'local',
      source: 'factory',
    });

    const runsResult = await createFactoryRunsRepository().list(factoryId);
    const runs = runsResult._unsafeUnwrap();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ issueNumber: 7, state: 'working', currentStep: 'implement' });
    expect(runs[0]!.threadIds).toEqual(['t-1']);
  });

  test('a sandbox runtime is not downgraded to a local thread', async () => {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime: async () => 'sandbox' as const,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
    expect((await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap()).toHaveLength(0);
  });

  test('does not re-admit an issue that already has an active run', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 'old', projectId: 'p1', userId: 'alice', status: 'running' });
    const runs = createFactoryRunsRepository();
    const first = await runs.start({
      factoryId,
      issueNumber: 7,
      threadIds: ['old'],
      currentStep: 'implement',
    });
    await runs.update(first._unsafeUnwrap().id, { state: 'working' });

    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
  });

  test('admits at most maxConcurrent issues per tick', async () => {
    await enableFactory({ maxConcurrent: 1 });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [
        { number: 1, title: 'a', url: 'u/1' },
        { number: 2, title: 'b', url: 'u/2' },
      ]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]!.body.title).toContain('#1');
  });

  test('a tick still running is not overlapped by the next one', async () => {
    await enableFactory();
    const poll = fakePoll();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: StartThreadInput[] = [];
    const slowLaunch = async (input: StartThreadInput) => {
      calls.push(input);
      await gate;
      return ok({ thread: { id: 't-1' }, threadId: 't-1', runnerId: 'r1' });
    };
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: slowLaunch as any,
      resolveRuntime,
    });

    const first = poll.ticks[0]!();
    await poll.ticks[0]!(); // fires while the first launch is still in flight
    release();
    await first;

    expect(calls).toHaveLength(1);
  });

  test('the issue is taken before the launch returns, so no second run starts for it', async () => {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    let seenDuringLaunch: unknown = 'unset';
    const launch = async () => {
      seenDuringLaunch = (
        await createFactoryRunsRepository().activeByIssue(factoryId, 7)
      )._unsafeUnwrap()?.state;
      return ok({ thread: { id: 't-1' }, threadId: 't-1', runnerId: 'r1' });
    };
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launch as any,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(seenDuringLaunch).toBe('queued');
  });

  test('a launch that fails leaves no run, and a later tick tries again', async () => {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    const offline = fakeLauncher('offline');
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: offline.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();
    await poll.ticks[0]!();

    expect(offline.calls).toHaveLength(2);
    expect((await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap()).toEqual([]);
  });

  test(`an issue that failed ${MAX_ATTEMPTS} times is not admitted again`, async () => {
    const factoryId = await enableFactory();
    const runs = createFactoryRunsRepository();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const run = (await runs.start({ factoryId, issueNumber: 7 }))._unsafeUnwrap();
      await runs.update(run.id, { state: 'failed' });
    }
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
  });

  test('a run waiting for a person frees its slot but still holds its issue', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1 });
    const runs = createFactoryRunsRepository();
    const parked = (await runs.start({ factoryId, issueNumber: 1 }))._unsafeUnwrap();
    await runs.update(parked.id, { state: 'waiting_human' });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [
        { number: 1, title: 'a', url: 'u/1' },
        { number: 2, title: 'b', url: 'u/2' },
      ]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls.map((call) => call.body.title)).toEqual(['[Factory] #2 b']);
  });

  test('a working run whose thread already finished is completed by the next tick', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-done', projectId: 'p1', userId: 'alice', status: 'completed' });
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({
        factoryId,
        issueNumber: 7,
        threadIds: ['t-done'],
        currentStep: 'implement',
        state: 'working',
      })
    )._unsafeUnwrap();
    const poll = fakePoll();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', []),
      createPoll: poll.createPoll,
      launch: fakeLauncher().launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    const [after] = (await runs.list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ id: run.id, state: 'waiting_human' });
  });

  test('skips the tick when the repo cannot be resolved', async () => {
    await enableFactory();
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub(null, [{ number: 1, title: 'a', url: 'u/1' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
  });
});

describe('onFactoryThreadTerminal', () => {
  test('a completed implement thread moves the run to waiting_human', async () => {
    const factoryId = await enableFactory();
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId, issueNumber: 3, threadIds: ['t-x'], currentStep: 'implement' })
    )._unsafeUnwrap();
    await runs.update(run.id, { state: 'working' });

    await onFactoryThreadTerminal('t-x', 'completed');

    const [after] = (await runs.list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ state: 'waiting_human', currentStep: null });
  });

  test('a failed implement thread fails the run', async () => {
    const factoryId = await enableFactory();
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId, issueNumber: 4, threadIds: ['t-y'], currentStep: 'implement' })
    )._unsafeUnwrap();
    await runs.update(run.id, { state: 'working' });

    await onFactoryThreadTerminal('t-y', 'failed');

    const [after] = (await runs.list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ state: 'failed', currentStep: null });
  });

  test('a second terminal signal for the same thread changes nothing', async () => {
    const factoryId = await enableFactory();
    const runs = createFactoryRunsRepository();
    await runs.start({
      factoryId,
      issueNumber: 5,
      threadIds: ['t-z'],
      currentStep: 'implement',
      state: 'working',
    });

    await onFactoryThreadTerminal('t-z', 'completed');
    await onFactoryThreadTerminal('t-z', 'failed');

    const [after] = (await runs.list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ state: 'waiting_human' });
  });

  test('ignores a thread with no factory run', async () => {
    await expect(onFactoryThreadTerminal('unknown', 'completed')).resolves.toBeUndefined();
  });
});
