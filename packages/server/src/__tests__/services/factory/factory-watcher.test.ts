/**
 * Issue factory watcher: scheduling, admission (dedup + concurrency), running
 * the factory's flow as the enabler (agent step → pull request → CI → merge),
 * and resuming a run after a restart — fake GitHub + fake launcher + fake
 * poll + scripted thread outcomes, real test DB.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import { err, ok, okAsync } from 'neverthrow';

import type { FactoryGithubPort, FactoryIssue } from '../../../services/factory/factory-github.js';
import type { FactoryMergeOutcome } from '../../../services/factory/factory-pull-requests.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../../services/factory/factory-runs.js';
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
import { createTestDb, seedProject, seedProjectMember, seedThread } from '../../helpers/test-db.js';

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

interface GithubScript {
  /** The default branch's `.funny/workflows/*` files, by path. */
  files?: Record<string, string>;
  /** Whether the agent opened its pull request. */
  pr?: boolean;
  ci?: CiState;
  merge?: FactoryMergeOutcome;
}

/** Fake GitHub side: a fixed repo and issue list, plus a scripted pull request. */
function fakeGithub(
  repo: string | null,
  issues: FactoryIssue[],
  script: GithubScript = {},
): FactoryGithubPort & { fileReads: string[]; merges: number } {
  const port = {
    fileReads: [] as string[],
    merges: 0,
    resolveRepo: async () => repo,
    listReadyIssues: () => okAsync(issues),
    getIssue: (_reader: unknown, number: number) =>
      okAsync({ number, title: `Issue ${number}`, url: `u/${number}` }),
    readDefaultBranchFile: (_reader: unknown, path: string) => {
      port.fileReads.push(path);
      return okAsync(script.files?.[path] ?? null);
    },
    findPullRequest: () =>
      okAsync(script.pr === false ? null : { number: 9, url: 'https://github.com/o/r/pull/9' }),
    pullRequests: {
      ciState: () => okAsync(script.ci ?? ({ kind: 'green' } as CiState)),
      merge: () => {
        port.merges++;
        return okAsync(
          script.merge ?? ({ kind: 'merged', method: 'squash', branchDeleted: true } as const),
        );
      },
    },
  };
  return port;
}

const resolveRuntime = async () => 'local' as const;

/** Agent threads that never finish until the watcher stops. */
const pendingThreads = async (_threadId: string, signal: AbortSignal) =>
  new Promise<{ status: 'cancelled' }>((resolve) =>
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' })),
  );

/** Agent threads that end at once with `status`. */
const finishedThreads = (status: 'completed' | 'failed') => async () => ({
  status,
  output: 'done',
});

/** Wait until the run of `factoryId` satisfies `done` (flows go on after the tick). */
async function eventually(
  factoryId: string,
  done: (run: FactoryRunView) => boolean,
): Promise<FactoryRunView> {
  for (let i = 0; i < 200; i++) {
    const [run] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    if (run && done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the run never reached the expected state');
}

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

  test("a tick admits an open issue and starts its flow's agent step for the enabler", async () => {
    const factoryId = await enableFactory({ label: 'ready-for-agent' });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]!.userId).toBe('alice');
    expect(launcher.calls[0]!.body).toMatchObject({
      projectId: 'p1',
      mode: 'local',
      source: 'factory',
    });
    expect(launcher.calls[0]!.body.prompt).toContain('issue #7 of acme/repo');

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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
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
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    expect(launcher.calls.map((call) => call.body.title)).toEqual(['[Factory] #2 b']);
  });

  test('a factory whose enabler lost steer access is turned off and starts nothing', async () => {
    seedProject(testDb.db, { id: 'bob-project', userId: 'bob', path: '/tmp/bob' });
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    const settings = createFactorySettingsService();
    (await settings.save('alice', 'bob-project', { enabled: true }))._unsafeUnwrap();
    // Demoted to viewer after turning the factory on.
    testDb.sqlite.query("UPDATE project_members SET role = 'viewer' WHERE user_id = 'alice'").run();
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
    expect((await settings.get('alice', 'bob-project'))._unsafeUnwrap()?.enabled).toBe(false);
    expect(scheduledFactoryCount()).toBe(0);
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
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
  });
});

describe('factory flow', () => {
  const issue7 = [{ number: 7, title: 'Fix it', url: 'u/7' }];

  async function runFlow(
    script: GithubScript,
    waitThread: (id: string, signal: AbortSignal) => Promise<any>,
  ) {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    const launcher = fakeLauncher();
    const github = fakeGithub('o/r', issue7, script);
    await startFactoryWatcher({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread,
    });
    await poll.ticks[0]!();
    return { factoryId, launcher, github, poll };
  }

  test('a completed agent step goes on to the pull request, green CI and the merge', async () => {
    const { factoryId, github } = await runFlow({}, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run).toMatchObject({ prUrl: 'https://github.com/o/r/pull/9', threadIds: ['t-1'] });
    expect(github.merges).toBe(1);
  });

  test('red CI fails the run and nothing is merged', async () => {
    const { factoryId, github } = await runFlow(
      { ci: { kind: 'failing', checks: [{ name: 'test', conclusion: 'failure', excerpt: '' }] } },
      finishedThreads('completed'),
    );
    await eventually(factoryId, (r) => r.state === 'failed');
    expect(github.merges).toBe(0);
  });

  test('a failed agent thread fails the run before any pull request step', async () => {
    const { factoryId } = await runFlow({}, finishedThreads('failed'));
    const run = await eventually(factoryId, (r) => r.state === 'failed');
    expect(run.prUrl).toBeNull();
  });

  test('an agent that opened no pull request fails the run', async () => {
    const { factoryId } = await runFlow({ pr: false }, finishedThreads('completed'));
    await eventually(factoryId, (r) => r.state === 'failed');
  });

  test('auto-merge enabled leaves the run for a person instead of claiming a merge', async () => {
    const { factoryId } = await runFlow(
      { merge: { kind: 'auto-merge-enabled', method: 'squash' } },
      finishedThreads('completed'),
    );
    await eventually(factoryId, (r) => r.state === 'waiting_human');
  });

  test("the repository's default-branch copy of the flow replaces the built-in", async () => {
    const custom = [
      'name: issue-to-merge',
      'inputs:',
      '  issue_number: { type: string, required: true }',
      'nodes:',
      '  - id: only',
      '    spawn_agent:',
      '      prompt: CUSTOM {{issue_number}}',
    ].join('\n');
    const { factoryId, launcher, github } = await runFlow(
      { files: { '.funny/workflows/issue-to-merge.yaml': custom } },
      finishedThreads('completed'),
    );
    await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(launcher.calls[0]!.body.prompt).toBe('CUSTOM 7');
    expect(github.fileReads).toEqual(['.funny/workflows/issue-to-merge.yaml']);
  });

  test('an invalid repository flow fails the run without starting an agent', async () => {
    const { factoryId, launcher } = await runFlow(
      { files: { '.funny/workflows/issue-to-merge.yaml': 'name: [' } },
      finishedThreads('completed'),
    );
    await eventually(factoryId, (r) => r.state === 'failed');
    expect(launcher.calls).toHaveLength(0);
  });

  async function seedInFlightRun(threadIds: string[]) {
    const factoryId = await enableFactory();
    await createFactoryRunsRepository().start({
      factoryId,
      issueNumber: 7,
      threadIds,
      state: 'working',
      currentStep: 'implement',
    });
    return factoryId;
  }

  test('after a restart a run resumes from its finished thread without starting another', async () => {
    seedThread(testDb.db, { id: 't-done', projectId: 'p1', userId: 'alice', status: 'completed' });
    const factoryId = await seedInFlightRun(['t-done']);
    const poll = fakePoll();
    const launcher = fakeLauncher();
    // The real wait: it reads the thread's persisted status.
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(0);
  });

  test('a run whose thread no longer exists fails its step', async () => {
    const factoryId = await seedInFlightRun(['gone']);
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    await eventually(factoryId, (r) => r.state === 'failed');
    expect(launcher.calls).toHaveLength(0);
  });

  test('stopping the watcher leaves an in-flight run for the next start', async () => {
    const { factoryId } = await runFlow({}, pendingThreads);
    await eventually(factoryId, (r) => r.state === 'working');
    stopFactoryWatcher();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [run] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(run).toMatchObject({ state: 'working', threadIds: ['t-1'] });
  });
});
