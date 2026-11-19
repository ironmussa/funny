/**
 * Issue factory watcher: scheduling, admission (dedup + concurrency), running
 * the factory's flow as the enabler (agent step → pull request → CI → merge),
 * and resuming a run after a restart — fake GitHub + fake launcher + fake
 * poll + scripted thread outcomes, real test DB.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import type { IssueBlocker } from '@funny/core/github-app';
import { err, errAsync, ok, okAsync } from 'neverthrow';

import { noteOwnerFollowUp } from '../../../services/factory/factory-follow-ups.js';
import type { FactoryGithubPort, FactoryIssue } from '../../../services/factory/factory-github.js';
import type { FactoryMergeOutcome } from '../../../services/factory/factory-pull-requests.js';
import {
  createFactoryRunControl,
  onFactoryThreadTerminal,
} from '../../../services/factory/factory-run-control.js';
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
import {
  createTestDb,
  seedMessage,
  seedProject,
  seedProjectMember,
  seedThread,
} from '../../helpers/test-db.js';

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
  /** CI answers in order; the last one repeats. */
  ci?: CiState | CiState[];
  merge?: FactoryMergeOutcome;
  /** Each issue's blockers (GitHub's "blocked by"); an issue absent here has none. */
  blockers?: Record<number, IssueBlocker[] | 'unreadable'>;
  /** Issues GitHub reports as closed. */
  closed?: number[];
  /** Each pull request's state, by number; an absent one is open. */
  prStates?: Record<number, 'open' | 'merged' | 'closed'>;
}

/** Fake GitHub side: a fixed repo and issue list, plus a scripted pull request. */
function fakeGithub(
  repo: string | null,
  issues: FactoryIssue[],
  script: GithubScript = {},
): FactoryGithubPort & { fileReads: string[]; merges: number } {
  const answers = ([] as CiState[]).concat(script.ci ?? { kind: 'green' });
  let looks = 0;
  const port = {
    fileReads: [] as string[],
    merges: 0,
    resolveRepo: async () => repo,
    listReadyIssues: () => okAsync(issues),
    getIssue: (_reader: unknown, number: number) =>
      okAsync({
        number,
        title: `Issue ${number}`,
        url: `u/${number}`,
        state: script.closed?.includes(number) ? ('closed' as const) : ('open' as const),
        pullRequest: false,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    issueBlockers: (_reader: unknown, number: number) => {
      const blockers = script.blockers?.[number] ?? [];
      return blockers === 'unreadable'
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync(blockers);
    },
    listDefaultBranchDir: () => okAsync([] as string[]),
    readDefaultBranchFile: (_reader: unknown, path: string) => {
      port.fileReads.push(path);
      return okAsync(script.files?.[path] ?? null);
    },
    findPullRequest: () =>
      okAsync(script.pr === false ? null : { number: 9, url: 'https://github.com/o/r/pull/9' }),
    pullRequests: {
      prState: (pr: { number: number }) => okAsync(script.prStates?.[pr.number] ?? 'open'),
      ciState: () => okAsync(answers[Math.min(looks++, answers.length - 1)]!),
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

async function enableFactory(
  opts: {
    label?: string;
    maxConcurrent?: number;
    flowName?: string;
    mode?: 'manual' | 'automatic';
  } = {},
) {
  const settings = createFactorySettingsService();
  // Most tests admit labelled issues: automatic mode unless a test says otherwise.
  const saved = await settings.save('alice', 'p1', { enabled: true, mode: 'automatic', ...opts });
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
    // A local runtime runs the agent in a worktree, never in the enabler's checkout.
    expect(launcher.calls[0]!.body).toMatchObject({
      projectId: 'p1',
      mode: 'worktree',
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

  test("a sandbox runtime starts the agent in the enabler's sandbox, marked as the factory's", async () => {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    const launcher = fakeLauncher();
    const sandboxCalls: Array<{ userId: string; body: Record<string, unknown> }> = [];
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime: async () => 'sandbox' as const,
      waitThread: pendingThreads,
      launchSandbox: async (userId, body) => {
        sandboxCalls.push({ userId, body });
        return ok({ thread: { id: 's-1' }, threadId: 's-1', runnerId: 'sandbox' });
      },
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0]!.userId).toBe('alice');
    expect(sandboxCalls[0]!.body).toMatchObject({ projectId: 'p1', source: 'factory' });
    // The sandbox launcher takes no thread mode: the sandbox is the isolation.
    expect(sandboxCalls[0]!.body.mode).toBeUndefined();
    const run = await eventually(factoryId, (r) => r.threadIds.length > 0);
    expect(run).toMatchObject({ state: 'working', threadIds: ['s-1'] });
  });

  test('a sandbox launch refusal starts nothing and the issue waits for a later tick', async () => {
    const factoryId = await enableFactory();
    const poll = fakePoll();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: fakeLauncher().launch,
      resolveRuntime: async () => 'sandbox' as const,
      waitThread: pendingThreads,
      launchSandbox: async () =>
        err({ kind: 'runner-error' as const, status: 409, message: 'no sandbox configured' }),
    });

    await poll.ticks[0]!();

    expect((await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap()).toEqual([]);
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

  test('the settings say why the factory is blocked, and clear it once it is not', async () => {
    await enableFactory();
    const poll = fakePoll();
    let repo: string | null = null;
    const github = { ...fakeGithub('acme/repo', []), resolveRepo: async () => repo };
    await startFactoryWatcher({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: fakeLauncher().launch,
      resolveRuntime,
      waitThread: pendingThreads,
    });
    const blocked = async () =>
      (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap()!.blockedReason;

    await poll.ticks[0]!();
    expect(await blocked()).toContain('Waiting for your runner');

    repo = 'acme/repo';
    await poll.ticks[0]!();
    expect(await blocked()).toBeNull();
  });

  test('an issue whose agent could not start is reported as the block', async () => {
    await enableFactory();
    const poll = fakePoll();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: fakeLauncher('offline').launch,
      resolveRuntime,
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    const settings = (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap()!;
    expect(settings.blockedReason).toContain('Issue #7 could not start');
    expect(settings.blockedReason).toContain('offline');
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
    const notices: Array<{ title: string; body: string }> = [];
    const followUps: Array<{ threadId: string; content: string }> = [];
    await startFactoryWatcher({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread,
      notify: async (_userId, notice) => notices.push(notice),
      followUp: async (_userId, threadId, content) => {
        followUps.push({ threadId, content });
        return ok(undefined);
      },
    });
    await poll.ticks[0]!();
    return { factoryId, launcher, github, poll, notices, followUps };
  }

  test('a completed agent step goes on to the pull request, green CI and the merge', async () => {
    const { factoryId, github } = await runFlow({}, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run).toMatchObject({ prUrl: 'https://github.com/o/r/pull/9', threadIds: ['t-1'] });
    expect(github.merges).toBe(1);
  });

  const red: CiState = {
    kind: 'failing',
    checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 1, got 2' }],
  };

  test('red CI continues the implement thread with the failing log, then merges once green', async () => {
    const { factoryId, launcher, github, followUps } = await runFlow(
      { ci: [red, { kind: 'green' }] },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    // The fix is a follow-up on the implement thread, keeping its context.
    expect(launcher.calls).toHaveLength(1);
    expect(run.threadIds).toEqual(['t-1', 't-1']);
    expect(followUps.map((f) => f.threadId)).toEqual(['t-1']);
    const fix = followUps[0]!.content;
    expect(fix).toContain('expected 1, got 2');
    expect(fix).toContain(`push to \`factory/issue-7-${run.id.slice(0, 8)}\``);
    expect(github.merges).toBe(1);
  });

  test('CI still red after the fix attempts waits for the member, notified, without merging', async () => {
    const { factoryId, launcher, github, notices, followUps } = await runFlow(
      { ci: red },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    // The implement agent plus two fixes on its thread: three looks at the CI in all.
    expect(launcher.calls).toHaveLength(1);
    expect(followUps).toHaveLength(2);
    expect(github.merges).toBe(0);
    expect(run.currentStep).toBe('ci');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Issue #7 needs you');
  });

  // The PR #342 retry: a 0security status in `error` sent the agent to "fix"
  // a billing check. Checks that could not run now wait for the member.
  test('checks that could not run wait for the member without a fix attempt', async () => {
    const blocked: CiState = {
      kind: 'blocked',
      checks: [{ name: '0security - PR Security', conclusion: 'error', excerpt: 'add a card' }],
    };
    const { factoryId, github, followUps, notices } = await runFlow(
      { ci: blocked },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(followUps).toHaveLength(0);
    expect(github.merges).toBe(0);
    expect(run.currentStep).toBe('ci');
    expect(run.failureReason).toContain('0security - PR Security');
    expect(notices).toHaveLength(1);
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

  // Issue #343: the factory thread shows the run's step chain and why it
  // failed, which were only in the server log.
  test('a failed run records its flow steps, the step it failed at and why', async () => {
    const { factoryId } = await runFlow({ pr: false }, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'failed');
    expect(run.flowSteps).toEqual(['implement', 'pull-request', 'ci', 'merge']);
    expect(run.currentStep).toBe('pull-request');
    expect(run.failureReason).toContain('No open pull request');
  });

  test('a merged run has its steps and no failure reason', async () => {
    const { factoryId } = await runFlow({}, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run.flowSteps).toEqual(['implement', 'pull-request', 'ci', 'merge']);
    expect(run.failureReason).toBeNull();
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

  test('the built-in issue-to-pr flow leaves the open pull request for a person', async () => {
    const factoryId = await enableFactory({ flowName: 'issue-to-pr' });
    const poll = fakePoll();
    const github = fakeGithub('o/r', issue7);
    await startFactoryWatcher({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: fakeLauncher().launch,
      resolveRuntime,
      waitThread: finishedThreads('completed'),
    });
    await poll.ticks[0]!();
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(run.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(github.merges).toBe(0);
  });

  test('the workspace-only factory-issue flow is refused before any agent starts', async () => {
    const factoryId = await enableFactory({ flowName: 'factory-issue' });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', issue7),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: finishedThreads('completed'),
    });
    await poll.ticks[0]!();
    await eventually(factoryId, (r) => r.state === 'failed');
    expect(launcher.calls).toHaveLength(0);
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

  test('a resumed run adopts the thread an interrupted launch started', async () => {
    const factoryId = await seedInFlightRun([]);
    const runs = createFactoryRunsRepository();
    const [seeded] = (await runs.list(factoryId))._unsafeUnwrap();
    const launchedAt = new Date().toISOString();
    await runs.update(seeded!.id, { launchStartedAt: launchedAt });
    // The runner created the thread, but the server crashed before recording it.
    seedThread(testDb.db, {
      id: 't-orphan',
      projectId: 'p1',
      userId: 'alice',
      status: 'completed',
      source: 'factory',
      title: '[Factory] #7 Issue 7',
      createdAt: launchedAt,
    });
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

    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run).toMatchObject({ threadIds: ['t-orphan'], launchStartedAt: null });
    expect(launcher.calls).toHaveLength(0);
  });

  test('a resumed run whose interrupted launch never reached the runner starts it', async () => {
    const factoryId = await seedInFlightRun([]);
    const runs = createFactoryRunsRepository();
    const [seeded] = (await runs.list(factoryId))._unsafeUnwrap();
    await runs.update(seeded!.id, { launchStartedAt: new Date().toISOString() });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: finishedThreads('completed'),
    });

    await poll.ticks[0]!();

    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(1);
  });

  test('a resumed run does not resend a follow-up that reached the thread before a crash', async () => {
    const factoryId = await seedInFlightRun(['t-impl']);
    const runs = createFactoryRunsRepository();
    const [seeded] = (await runs.list(factoryId))._unsafeUnwrap();
    const sentAt = new Date().toISOString();
    await runs.update(seeded!.id, {
      prUrl: 'https://github.com/o/r/pull/9',
      launchStartedAt: sentAt,
    });
    seedThread(testDb.db, { id: 't-impl', projectId: 'p1', userId: 'alice', status: 'completed' });
    // The fix's follow-up reached the thread; the server crashed before recording it.
    seedMessage(testDb.db, { id: 'm-fix', threadId: 't-impl', role: 'user', timestamp: sentAt });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    const followUps: string[] = [];
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', [], {
        ci: [
          { kind: 'failing', checks: [{ name: 'test', conclusion: 'failure', excerpt: 'x' }] },
          { kind: 'green' },
        ],
      }),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: finishedThreads('completed'),
      followUp: async (_userId, threadId) => {
        followUps.push(threadId);
        return ok(undefined);
      },
    });

    await poll.ticks[0]!();

    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run.threadIds).toEqual(['t-impl', 't-impl']);
    expect(followUps).toEqual([]);
    expect(launcher.calls).toHaveLength(0);
  });

  test('the database refuses a second in-flight run for an issue', async () => {
    const factoryId = await enableFactory();
    const runs = createFactoryRunsRepository();
    (await runs.start({ factoryId, issueNumber: 7 }))._unsafeUnwrap();
    expect((await runs.start({ factoryId, issueNumber: 7 })).isErr()).toBe(true);
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

describe('factory operator controls', () => {
  const issue7 = [{ number: 7, title: 'Fix it', url: 'u/7' }];

  async function watch(
    opts: {
      issues?: FactoryIssue[];
      waitThread?: (id: string, signal: AbortSignal) => Promise<any>;
      checkAccess?: (userId: string, projectId: string) => Promise<boolean>;
      github?: GithubScript;
    } = {},
  ) {
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', opts.issues ?? issue7, opts.github),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: opts.waitThread ?? pendingThreads,
      checkAccess: opts.checkAccess,
      notify: async () => undefined,
    });
    return { poll, launcher };
  }

  /** A run that parked a minute ago (its `completedAt` is when it parked). */
  async function seedParkedRun(factoryId: string, threadIds: string[]) {
    const run = await seedRun(factoryId, 'working', threadIds);
    await createFactoryRunsRepository().update(run.id, { state: 'waiting_human' });
    const parked = new Date(Date.now() - 60_000).toISOString();
    testDb.sqlite
      .query('UPDATE factory_runs SET completed_at = ? WHERE id = ?')
      .run(parked, run.id);
    return (await createFactoryRunsRepository().get(run.id))._unsafeUnwrap()!;
  }

  async function seedRun(factoryId: string, state: FactoryRunView['state'], threadIds: string[]) {
    return (
      await createFactoryRunsRepository().start({ factoryId, issueNumber: 7, threadIds, state })
    )._unsafeUnwrap();
  }

  /** A run parked waiting for the member with its pull request #9 open, as at a blocked CI. */
  async function seedParkedWithPr(factoryId: string) {
    const run = await seedRun(factoryId, 'waiting_human', ['t-1']);
    await createFactoryRunsRepository().update(run.id, {
      prUrl: 'https://github.com/o/r/pull/9',
      currentStep: 'ci',
      failureReason: 'Checks that need a person, not a code change: 0security - PR Security',
    });
    return run;
  }

  const runById = async (runId: string) =>
    (await createFactoryRunsRepository().get(runId))._unsafeUnwrap()!;

  // Run 5e77aded (issue #195): it waited at a CI check that could not run, a
  // person merged its PR #349, and the run stayed "waiting for you".
  test('a parked run whose pull request a person merged is closed as merged', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    const { poll } = await watch({ issues: [], github: { prStates: { 9: 'merged' } } });

    await poll.ticks[0]!();

    expect(await runById(run.id)).toMatchObject({
      state: 'merged',
      currentStep: null,
      failureReason: null,
    });
  });

  test('a parked run whose pull request was closed without a merge is stopped, saying so', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    const { poll } = await watch({ issues: [], github: { prStates: { 9: 'closed' } } });

    await poll.ticks[0]!();

    const closed = await runById(run.id);
    expect(closed.state).toBe('stopped');
    expect(closed.failureReason).toContain('closed without a merge');
  });

  test('a parked run whose pull request is still open keeps waiting for the member', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    const { poll } = await watch({ issues: [] });

    await poll.ticks[0]!();

    expect((await runById(run.id)).state).toBe('waiting_human');
  });

  test('closing a parked run is a compare-and-set: a run retried meanwhile is left alone', async () => {
    const factoryId = await enableFactory();
    const run = await seedRun(factoryId, 'queued', []);
    const repo = createFactoryRunsRepository();

    expect((await repo.closeParked(run.id, 'merged'))._unsafeUnwrap()).toBe(false);
    expect((await runById(run.id)).state).toBe('queued');
  });

  test('a paused factory finishes its run in flight but admits no new issue', async () => {
    const factoryId = await enableFactory();
    await createFactorySettingsService().save('alice', 'p1', { enabled: false });
    seedThread(testDb.db, { id: 't-done', projectId: 'p1', userId: 'alice', status: 'completed' });
    await seedRun(factoryId, 'working', ['t-done']);
    const { poll, launcher } = await watch({
      issues: [{ number: 8, title: 'New', url: 'u/8' }],
      waitThread: finishedThreads('completed'),
    });

    expect(scheduledFactoryCount()).toBe(1);
    await poll.ticks[0]!();

    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(0);
  });

  test('a paused factory with nothing in flight is not polled', async () => {
    await enableFactory();
    await createFactorySettingsService().save('alice', 'p1', { enabled: false });
    await watch();
    expect(scheduledFactoryCount()).toBe(0);
  });

  test("losing the enabler's access stops their open runs too", async () => {
    const factoryId = await enableFactory();
    const run = await seedRun(factoryId, 'waiting_human', ['t-1']);
    const { poll } = await watch({ checkAccess: async () => false });

    await poll.ticks[0]!();

    const [after] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ id: run.id, state: 'stopped' });
  });

  test('stopping a run ends it and its flow does not go on', async () => {
    const factoryId = await enableFactory();
    const { poll, launcher } = await watch();
    await poll.ticks[0]!();
    const running = await eventually(factoryId, (r) => r.state === 'working');

    const stopped = await createFactoryRunControl().stop('alice', factoryId, running.id);

    expect(stopped._unsafeUnwrap().state).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [after] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(after!.state).toBe('stopped');
    expect(launcher.calls).toHaveLength(1);
    // Stopping twice is refused: the run already ended.
    const again = await createFactoryRunControl().stop('alice', factoryId, running.id);
    expect(again.isErr() && again.error.kind).toBe('conflict');
  });

  test('a run of another factory cannot be controlled', async () => {
    const factoryId = await enableFactory();
    const run = await seedRun(factoryId, 'failed', []);
    const control = createFactoryRunControl();
    const stop = await control.stop('alice', 'other-factory', run.id);
    expect(stop.isErr() && stop.error.kind).toBe('not-found');
    const retry = await control.retry('other-factory', run.id);
    expect(retry.isErr() && retry.error.kind).toBe('not-found');
  });

  test('retrying a run whose agent failed starts the agent again', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-bad', projectId: 'p1', userId: 'alice', status: 'failed' });
    const run = await seedRun(factoryId, 'failed', ['t-bad']);
    const { launcher } = await watch({ issues: [], waitThread: finishedThreads('completed') });

    await createFactoryRunsRepository().update(run.id, { failureReason: 'The agent failed.' });

    const retried = await createFactoryRunControl().retry(factoryId, run.id);

    // A retried run no longer says it failed.
    expect(retried._unsafeUnwrap()).toMatchObject({
      state: 'queued',
      threadIds: [],
      failureReason: null,
    });
    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(1);
  });

  test('retrying keeps a completed implement step and runs the later steps again', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-ok', projectId: 'p1', userId: 'alice', status: 'completed' });
    seedThread(testDb.db, { id: 't-fix', projectId: 'p1', userId: 'alice', status: 'completed' });
    const run = await seedRun(factoryId, 'waiting_human', ['t-ok', 't-fix']);

    const retried = await createFactoryRunControl().retry(factoryId, run.id);

    expect(retried._unsafeUnwrap().threadIds).toEqual(['t-ok']);
  });

  test('only a failed or waiting run can be retried', async () => {
    const factoryId = await enableFactory();
    const run = await seedRun(factoryId, 'merged', []);
    const retried = await createFactoryRunControl().retry(factoryId, run.id);
    expect(retried.isErr() && retried.error.kind).toBe('conflict');
  });

  test("a member's follow-up on a waiting run's thread takes the run over", async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-impl', projectId: 'p1', userId: 'alice', status: 'completed' });
    await seedParkedRun(factoryId, ['t-impl']);
    // The real wait: the replayed step reads t-impl's persisted status.
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      notify: async () => undefined,
    });

    // The owner's follow-up (noted by the message route) ran on t-impl and completed again.
    noteOwnerFollowUp('t-impl');
    await onFactoryThreadTerminal('t-impl', 'completed');

    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(0);
  });

  test('a completion with no owner follow-up since the run parked does not reopen it', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-s']);
    // A steer sharee's follow-up is never noted, and a duplicate terminal
    // write has no follow-up at all: neither moves the flow on to a merge.
    await onFactoryThreadTerminal('t-s', 'completed');
    // A note from before the run parked does not count either.
    noteOwnerFollowUp('t-s', Date.parse(run.completedAt!) - 1000);
    await onFactoryThreadTerminal('t-s', 'completed');
    const after = (await createFactoryRunsRepository().get(run.id))._unsafeUnwrap();
    expect(after!.state).toBe('waiting_human');
  });

  test('retrying while the runner is offline keeps the run, failed, instead of dropping it', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-bad', projectId: 'p1', userId: 'alice', status: 'failed' });
    const run = await seedRun(factoryId, 'failed', ['t-bad']);
    const poll = fakePoll();
    await startFactoryWatcher({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: fakeLauncher('offline').launch,
      resolveRuntime,
      waitThread: pendingThreads,
      notify: async () => undefined,
    });

    (await createFactoryRunControl().retry(factoryId, run.id))._unsafeUnwrap();

    const after = await eventually(factoryId, (r) => r.state === 'failed');
    expect(after.id).toBe(run.id);
  });

  test('a follow-up that fails, or on an earlier thread, does not reopen the run', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-a', 't-b']);
    noteOwnerFollowUp('t-a');
    noteOwnerFollowUp('t-b');
    await onFactoryThreadTerminal('t-b', 'failed');
    await onFactoryThreadTerminal('t-a', 'completed');
    const after = (await createFactoryRunsRepository().get(run.id))._unsafeUnwrap();
    expect(after!.state).toBe('waiting_human');
  });
});
