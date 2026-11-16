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
  scheduledFactoryCount,
  startFactoryWatcher,
  stopFactoryWatcher,
} from '../../../services/factory/factory-watcher.js';
import type { StartThreadInput } from '../../../services/runner-thread-launcher.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

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

  test('does not re-admit an issue that already has an active run', async () => {
    const factoryId = await enableFactory();
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

  test('ignores a thread with no factory run', async () => {
    await expect(onFactoryThreadTerminal('unknown', 'completed')).resolves.toBeUndefined();
  });
});
