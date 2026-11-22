/**
 * Issue factory watcher: scheduling, admission (dedup + concurrency), running
 * the factory's flow as the enabler (agent step → pull request → CI → merge),
 * and resuming a run after a restart — fake GitHub + fake launcher + fake
 * poll + scripted thread outcomes, real test DB.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { CiState } from '@funny/core/github-app';
import type { IssueBlocker } from '@funny/core/github-app';
import { err, errAsync, ok, okAsync, ResultAsync } from 'neverthrow';

import { log } from '../../../lib/logger.js';
import { NO_CHANGE_LINE } from '../../../services/factory/factory-action-provider.js';
import { noteOwnerFollowUp } from '../../../services/factory/factory-follow-ups.js';
import type { FactoryGithubPort, FactoryIssue } from '../../../services/factory/factory-github.js';
import type {
  FactoryMergeOutcome,
  FactoryProofCheck,
} from '../../../services/factory/factory-pull-requests.js';
import {
  createFactoryRunControl,
  onFactoryThreadTerminal,
} from '../../../services/factory/factory-run-control.js';
import {
  createFactoryRunsRepository,
  factoryRunBranch,
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
import { createWorkflowJournalRepository } from '../../../services/workflow-engine/journal-repository.js';
import {
  launchedThread,
  passingProof,
  proofReadyFlowFiles,
  runnerOffline,
  unusedRunnerPorts,
  type LaunchResult,
} from '../../helpers/builders-services.js';
import {
  createTestDb,
  seedMessage,
  seedProject,
  seedProjectMember,
  seedThread,
} from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

const ports = unusedRunnerPorts();

const _origStartWatcher = startFactoryWatcher;
const startWatcherWithProof: typeof startFactoryWatcher = (d) =>
  _origStartWatcher({ proof: passingProof, ...d });

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
  const launch = async (input: StartThreadInput): Promise<LaunchResult> => {
    calls.push(input);
    return result === 'ok' ? launchedThread(`t-${calls.length}`) : runnerOffline('offline');
  };
  return { calls, launch };
}

interface GithubScript {
  /** The default branch's `.funny/workflows/*` files, by path. */
  files?: Record<string, string>;
  /** No repository copy of `issue-to-merge`: the built-in flow, which has no proof rules. */
  builtInFlow?: boolean;
  /** Whether the agent opened its pull request. */
  pr?: boolean;
  /** CI answers in order; the last one repeats. */
  ci?: CiState | CiState[];
  merge?: FactoryMergeOutcome;
  /** While set, a merge call waits for it before answering. */
  mergeHold?: () => Promise<void>;
  /** Each issue's blockers (GitHub's "blocked by"); an issue absent here has none. */
  blockers?: Record<number, IssueBlocker[] | 'unreadable'>;
  /** Issues GitHub reports as closed. */
  closed?: number[];
  /** Each pull request's state, by number; an absent one is open. */
  prStates?: Record<number, 'open' | 'merged' | 'closed'>;
  /** The pull request on each branch in any state (lookups with `state: 'all'`). */
  branchPrs?: Record<string, { number: number; url: string }>;
  /** Whether the run's branch has commits the default branch does not (default true). */
  branchAhead?: boolean;
  /** The pull request's head now (default `sha-head`, auto-merge off). */
  head?: { sha: string; autoMerge: boolean };
  /** GitHub does not answer for issues. */
  issuesUnreadable?: boolean;
  /** How many times publishing the proof check fails before it works. */
  publishFailures?: number;
}

/** Fake GitHub side: a fixed repo and issue list, plus a scripted pull request. */
/** The fake GitHub port, with what the test reads back. */
type FakeGithub = FactoryGithubPort & {
  fileReads: string[];
  merges: number;
  comments: Array<{ issue: number; body: string }>;
  checks: FactoryProofCheck[];
  prLookups: Array<{ branch: string; state: string }>;
};

function fakeGithub(
  repo: string | null,
  issues: FactoryIssue[],
  script: GithubScript = {},
): FakeGithub {
  const answers: CiState[] = [script.ci ?? { kind: 'green' }].flat();
  let looks = 0;
  let publishFailures = script.publishFailures ?? 0;
  const port: FakeGithub = {
    fileReads: [],
    merges: 0,
    comments: [],
    checks: [],
    prLookups: [],
    resolveRepo: async () => repo,
    listReadyIssues: () => okAsync(issues),
    getIssue: (_reader: unknown, number: number) =>
      script.issuesUnreadable
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync({
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
    listDefaultBranchDir: () => okAsync([]),
    readDefaultBranchFile: (_reader: unknown, path: string) => {
      port.fileReads.push(path);
      const repoFlows = script.builtInFlow ? {} : proofReadyFlowFiles();
      return okAsync({ ...repoFlows, ...script.files }[path] ?? null);
    },
    branchAhead: () => okAsync(script.branchAhead ?? true),
    commentOnIssue: (_reader: unknown, issue: number, body: string) => {
      port.comments.push({ issue, body });
      return okAsync(undefined);
    },
    findPullRequest: (_reader: unknown, branch: string, state: 'open' | 'all' = 'open') => {
      port.prLookups.push({ branch, state });
      if (state === 'all') return okAsync(script.branchPrs?.[branch] ?? null);
      return okAsync(
        script.pr === false ? null : { number: 9, url: 'https://github.com/o/r/pull/9' },
      );
    },
    pullRequests: {
      prState: (pr: { number: number }) => okAsync(script.prStates?.[pr.number] ?? 'open'),
      pullHead: () =>
        okAsync({ sha: 'sha-head', autoMerge: false, ...script.head, baseRef: 'main' }),
      publishProofCheck: (_pr: unknown, check: FactoryProofCheck) => {
        if (publishFailures-- > 0) {
          return errAsync({ kind: 'not-installed' as const, message: 'GitHub answered 502' });
        }
        port.checks.push(check);
        return okAsync(undefined);
      },
      ciState: () => okAsync(answers[Math.min(looks++, answers.length - 1)]!),
      merge: () => {
        port.merges++;
        const outcome =
          script.merge ?? ({ kind: 'merged', method: 'squash', branchDeleted: true } as const);
        const hold = script.mergeHold;
        return hold ? ResultAsync.fromSafePromise(hold().then(() => outcome)) : okAsync(outcome);
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
    db: testDb.db,
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

    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    const slowLaunch = async (input: StartThreadInput): Promise<LaunchResult> => {
      calls.push(input);
      await gate;
      return launchedThread('t-1');
    };
    await startWatcherWithProof({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: slowLaunch,
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
    const launch = async (): Promise<LaunchResult> => {
      seenDuringLaunch = (
        await createFactoryRunsRepository().activeByIssue(factoryId, 7)
      )._unsafeUnwrap()?.state;
      return launchedThread('t-1');
    };
    await startWatcherWithProof({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch,
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    const followUps: Array<{ threadId: string; content: string; expectedBranch?: string }> = [];
    const cleanups: Array<{ userId: string; threadIds: string[] }> = [];
    await startWatcherWithProof({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread,
      cleanupMerged: async (userId, threadIds) => {
        cleanups.push({ userId, threadIds });
      },
      notify: async (_userId, notice) => notices.push(notice),
      followUp: async (_userId, threadId, content, expectedBranch) => {
        followUps.push({ threadId, content, expectedBranch });
        return ok(undefined);
      },
    });
    await poll.ticks[0]!();
    return { factoryId, launcher, github, poll, notices, followUps, cleanups };
  }

  test('a completed agent step goes on to the pull request, green CI and the merge', async () => {
    const { factoryId, github } = await runFlow({}, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run).toMatchObject({ prUrl: 'https://github.com/o/r/pull/9', threadIds: ['t-1'] });
    expect(github.merges).toBe(1);
  });

  test("a merge cleans up the run's worktrees on the enabler's runner", async () => {
    const { factoryId, cleanups } = await runFlow({}, finishedThreads('completed'));
    await eventually(factoryId, (r) => r.state === 'merged');
    for (let i = 0; i < 100 && cleanups.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cleanups).toEqual([{ userId: 'alice', threadIds: ['t-1'] }]);
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
    // The fix only runs while the worktree is still on the run's branch.
    expect(followUps[0]!.expectedBranch).toBe(`factory/issue-7-${run.id.slice(0, 8)}`);
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

  test('an agent that made no commit parks the run as "no change", says so on the issue and cleans up', async () => {
    const { factoryId, github, cleanups, poll, launcher } = await runFlow(
      { pr: false, branchAhead: false },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(run.failureReason).toBe('no change');
    expect(run.currentStep).toBe('pull-request');
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.issue).toBe(7);
    expect(github.comments[0]!.body).toStartWith(NO_CHANGE_LINE);
    expect(cleanups).toEqual([{ userId: 'alice', threadIds: ['t-1'] }]);
    expect(github.merges).toBe(0);
    // Parked, it still holds its issue: a later tick does not admit it again.
    await poll.ticks[0]!();
    expect(launcher.calls).toHaveLength(1);
  });

  // Issue #343: the factory thread shows the run's step chain and why it
  // failed, which were only in the server log.
  test('a failed run records its flow steps, the step it failed at and why', async () => {
    const { factoryId } = await runFlow({ pr: false }, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'failed');
    expect(run.flowSteps).toEqual(['implement', 'pull-request', 'regression-proof', 'ci', 'merge']);
    expect(run.currentStep).toBe('pull-request');
    expect(run.failureReason).toContain('No open pull request');
  });

  describe('admission needs a proof-ready flow (task 4.6)', () => {
    const blocked = async () =>
      (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap()!.blockedReason;
    const runsOf = async (factoryId: string) =>
      (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();

    test('the built-in flow, with no proof rules, admits nothing and says why', async () => {
      const { factoryId, launcher } = await runFlow({ builtInFlow: true }, pendingThreads);
      expect(await runsOf(factoryId)).toEqual([]);
      expect(launcher.calls).toHaveLength(0);
      expect(await blocked()).toContain('Regression proof not configured');
    });

    test('once rules are added the issue is admitted and the blocker clears', async () => {
      const script: GithubScript = { builtInFlow: true };
      const { factoryId, poll } = await runFlow(script, pendingThreads);
      expect(await runsOf(factoryId)).toEqual([]);
      script.builtInFlow = false;
      await poll.ticks[0]!();
      expect(await runsOf(factoryId)).toHaveLength(1);
      expect(await blocked()).toBeNull();
    });

    test('a merge that opts out of the proof is admitted without rules', async () => {
      const optOut = proofReadyFlowFiles()
        ['.funny/workflows/issue-to-merge.yaml']!.replace(/      rules:\n.*\n.*\n/, '')
        .replace('    merge:', '    merge:\n      require_regression_proof: false');
      expect(optOut).not.toContain('    regression_proof:\n      rules:');
      const { factoryId } = await runFlow(
        { files: { '.funny/workflows/issue-to-merge.yaml': optOut } },
        pendingThreads,
      );
      expect(await runsOf(factoryId)).toHaveLength(1);
    });

    test('a run in flight goes on when its flow stops being proof-ready', async () => {
      const script: GithubScript = {};
      const { factoryId, poll } = await runFlow(script, pendingThreads);
      const [admitted] = await runsOf(factoryId);
      script.builtInFlow = true;
      await poll.ticks[0]!();
      const [still] = await runsOf(factoryId);
      expect(still!.id).toBe(admitted!.id);
      expect(still!.state).toBe(admitted!.state);
    });
  });

  test('a merged run has its steps and no failure reason', async () => {
    const { factoryId } = await runFlow({}, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(run.flowSteps).toEqual(['implement', 'pull-request', 'regression-proof', 'ci', 'merge']);
    expect(run.failureReason).toBeNull();
  });

  test('auto-merge enabled leaves the run for a person instead of claiming a merge', async () => {
    const { factoryId } = await runFlow(
      { merge: { kind: 'auto-merge-enabled', method: 'squash' } },
      finishedThreads('completed'),
    );
    await eventually(factoryId, (r) => r.state === 'waiting_human');
  });

  describe('a merge group shared by the runs of one repository (end to end, task 6.2)', () => {
    const GROUPED_FLOW = [
      'name: issue-to-merge',
      'inputs:',
      '  repo: { type: string, required: true }',
      '  issue_number: { type: string, required: true }',
      '  branch: { type: string, required: true }',
      'nodes:',
      '  - id: implement',
      '    spawn_agent:',
      '      prompt: Implement {{issue_number}} on {{branch}}',
      '  - id: pull-request',
      '    depends_on: [implement]',
      '    create_pr: { title: t }',
      '  - id: ci',
      '    depends_on: [pull-request]',
      '    wait_ci: {}',
      '  - id: merge',
      '    depends_on: [ci]',
      '    concurrency: { group: "merge-{{inputs.repo}}", limit: 1 }',
      '    merge: { method: squash, require_regression_proof: false }',
    ].join('\n');
    const twoIssues = [
      { number: 1, title: 'a', url: 'u/1' },
      { number: 2, title: 'b', url: 'u/2' },
    ];

    const rows = (table: string) =>
      testDb.sqlite.query(`SELECT group_key, holder FROM ${table}`).all() as Array<{
        group_key: string;
        holder: string;
      }>;

    async function allRuns(factoryId: string) {
      return (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    }

    async function until(check: () => Promise<boolean> | boolean, what: string) {
      for (let i = 0; i < 400; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`never: ${what}`);
    }

    /** A merge hold the test releases. */
    function mergeHold() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      return { hold: () => released, release };
    }

    async function startGrouped(hold: ReturnType<typeof mergeHold>) {
      const factoryId = await enableFactory({ maxConcurrent: 2 });
      const poll = fakePoll();
      const launcher = fakeLauncher();
      const github = fakeGithub('o/r', twoIssues, {
        files: { '.funny/workflows/issue-to-merge.yaml': GROUPED_FLOW },
        mergeHold: hold.hold,
      });
      const start = () =>
        startWatcherWithProof({
          ports,
          github,
          createPoll: poll.createPoll,
          launch: launcher.launch,
          resolveRuntime,
          waitThread: finishedThreads('completed'),
          followUp: async () => ok(undefined),
        });
      await start();
      await poll.ticks[0]!();
      return { factoryId, poll, launcher, github, start };
    }

    test('two runs merge one after the other, the second waiting on the database lease', async () => {
      const hold = mergeHold();
      const { factoryId, github, launcher } = await startGrouped(hold);

      // One run merges (its merge held); the other reached merge and waits for the slot.
      await until(() => rows('workflow_concurrency_waiters').length === 1, 'a waiter');
      expect(github.merges).toBe(1);
      const [lease] = rows('workflow_concurrency_leases');
      expect(lease?.group_key).toBe('merge-o/r');
      const [waiter] = rows('workflow_concurrency_waiters');
      expect(waiter?.group_key).toBe('merge-o/r');
      // Holders are `<runId>/<node>/<visit>`: the lease and the waiter are the two runs.
      const runs = await allRuns(factoryId);
      const runOf = (holder?: string) => holder?.split('/')[0];
      expect(new Set([runOf(lease?.holder), runOf(waiter?.holder)])).toEqual(
        new Set(runs.map((r) => r.id)),
      );
      await until(
        async () => (await allRuns(factoryId)).every((r) => r.currentStep === 'merge'),
        'both runs at merge (the waiting one reported by waiting_slot)',
      );
      expect((await allRuns(factoryId)).every((r) => r.state !== 'merged')).toBe(true);
      expect(github.merges).toBe(1);

      hold.release();
      await until(
        async () => (await allRuns(factoryId)).every((r) => r.state === 'merged'),
        'both runs merged',
      );
      expect(github.merges).toBe(2);
      expect(launcher.calls).toHaveLength(2);
      expect(rows('workflow_concurrency_leases')).toHaveLength(0);
      expect(rows('workflow_concurrency_waiters')).toHaveLength(0);
    });

    test('a restart while one run merges and the other waits resumes both without a second agent thread', async () => {
      const hold = mergeHold();
      const { factoryId, github, launcher, poll, start } = await startGrouped(hold);
      await until(() => rows('workflow_concurrency_waiters').length === 1, 'a waiter');

      // The server stops mid-run: the held merge finishes on its own, the waiter leaves.
      stopFactoryWatcher();
      hold.release();
      await start();
      await poll.ticks.at(-1)!();

      await until(
        async () => (await allRuns(factoryId)).every((r) => r.state === 'merged'),
        'both runs merged after the restart',
      );
      // One agent thread per issue: the resumed runs adopted theirs from the journal.
      expect(launcher.calls).toHaveLength(2);
      expect(github.merges).toBeGreaterThanOrEqual(2);
      expect(rows('workflow_concurrency_leases')).toHaveLength(0);
    });
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
    // Read for the admission check and for the run: only ever the default branch's copy.
    expect([...new Set(github.fileReads)]).toEqual(['.funny/workflows/issue-to-merge.yaml']);
  });

  test('a flow with a parse warning is logged and still runs', async () => {
    const custom = [
      'name: issue-to-merge',
      'inputs:',
      '  issue_number: { type: string, required: true }',
      'nodes:',
      '  - id: only',
      '    spawn_agent:',
      '      prompt: CUSTOM {{issue_number}}',
      '    on_error: continue',
      '  - id: after',
      '    depends_on: [only]',
      '    notify: { message: done }',
    ].join('\n');
    const warned: Array<{ message: unknown; meta: unknown }> = [];
    const record = (message: unknown, meta?: unknown) => {
      warned.push({ message, meta });
      return log;
    };
    // SAFETY: the factory calls log.warn(message, meta); `record` takes exactly that shape.
    const warn = spyOn(log, 'warn').mockImplementation(record as typeof log.warn);
    try {
      const { factoryId, launcher } = await runFlow(
        { files: { '.funny/workflows/issue-to-merge.yaml': custom } },
        finishedThreads('completed'),
      );
      await eventually(factoryId, (r) => r.state !== 'queued' && r.state !== 'working');
      expect(launcher.calls[0]!.body.prompt).toBe('CUSTOM 7');
      const logged = warned.find((w) => w.message === 'Issue factory flow has a warning');
      expect(logged?.meta).toMatchObject({
        flow: 'issue-to-merge',
        path: 'nodes.1.trigger_rule',
        warning: expect.stringContaining('"after" is skipped if "only" fails'),
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('the built-in issue-to-pr flow leaves the open pull request for a person', async () => {
    const factoryId = await enableFactory({ flowName: 'issue-to-pr' });
    const poll = fakePoll();
    const github = fakeGithub('o/r', issue7);
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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

  test('a resumed run adopts through the journal the thread its implement step checkpointed', async () => {
    // The implement step started t-impl and checkpointed it; the server then
    // stopped before recording the thread in the run (no thread_ids, no marker).
    const factoryId = await seedInFlightRun([]);
    const [seeded] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    await createWorkflowJournalRepository().record({
      runId: seeded!.id,
      nodeId: 'implement',
      visit: '1',
      attempt: 1,
      status: 'running',
      data: { phase: 'thread', threadId: 't-impl' },
      startedAt: Date.now(),
    });
    seedThread(testDb.db, { id: 't-impl', projectId: 'p1', userId: 'alice', status: 'completed' });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    await startWatcherWithProof({
      ports,
      github: fakeGithub('o/r', []),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
    });

    await poll.ticks[0]!();

    const run = await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(0);
    expect(run.threadIds).toEqual(['t-impl']);
    const implement = (await createWorkflowJournalRepository().load(seeded!.id))
      ._unsafeUnwrap()
      .filter((e) => e.nodeId === 'implement')
      .map((e) => [e.attempt, e.status]);
    expect(implement).toEqual([
      [1, 'running'],
      [2, 'succeeded'],
    ]);
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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
      proof?: Parameters<typeof startFactoryWatcher>[0]['proof'];
      runsPushedCommits?: (threadId: string) => Promise<boolean>;
    } = {},
  ) {
    const recorded: Array<{ spec: any; outcome: any }> = [];
    const poll = fakePoll();
    const launcher = fakeLauncher();
    const github = fakeGithub('o/r', opts.issues ?? issue7, opts.github);
    const cleanups: Array<{ userId: string; threadIds: string[] }> = [];
    await startWatcherWithProof({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: opts.waitThread ?? pendingThreads,
      checkAccess: opts.checkAccess,
      cleanupMerged: async (userId, threadIds) => {
        cleanups.push({ userId, threadIds });
      },
      notify: async () => undefined,
      activities: {
        recordServerActivity: async (spec, outcome) => {
          recorded.push({ spec, outcome });
        },
      },
      proof: opts.proof ?? passingProof,
      runsPushedCommits: opts.runsPushedCommits,
    });
    return { poll, launcher, github, cleanups, recorded };
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
  describe('a run waiting on auto-merge whose head moved (task 4.4)', () => {
    /** A run that enabled auto-merge after proving `sha-old`. */
    async function seedAutoMergeRun(factoryId: string) {
      const run = await seedRun(factoryId, 'waiting_human', ['t-1']);
      await createFactoryRunsRepository().update(run.id, {
        prUrl: 'https://github.com/o/r/pull/9',
        currentStep: null,
        regressionProof: { headSha: 'sha-old', verdict: 'pass', ranAt: '2026-11-22T10:00:00Z' },
      });
      return run;
    }

    /** A runner that proves the commit it is asked for, with `verdict`. */
    const provingAs = (verdict: 'pass' | 'fail', asked: string[]) => () => ({
      startProof: async (_threadId: string, body: Record<string, unknown>) => {
        asked.push(String(body.headSha));
        return ok({ proofId: 'p1', state: 'running' });
      },
      pollProof: async () =>
        ok({
          state: 'done',
          result: {
            verdict,
            failureKind: 'test',
            headSha: asked.at(-1),
            finding: verdict === 'fail' ? 'The tests pass on the base commit' : undefined,
          },
        }),
    });

    async function eventuallyRun(runId: string, done: (run: FactoryRunView) => boolean) {
      for (let i = 0; i < 200; i++) {
        const run = await runById(runId);
        if (done(run)) return run;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('the run never reached the expected state');
    }

    test('the new head is proved and its check published; the run keeps waiting', async () => {
      const factoryId = await enableFactory();
      const run = await seedAutoMergeRun(factoryId);
      const asked: string[] = [];
      const { poll, github } = await watch({
        issues: [],
        github: { head: { sha: 'sha-new', autoMerge: true } },
        proof: provingAs('pass', asked),
      });

      await poll.ticks[0]!();
      const reproved = await eventuallyRun(
        run.id,
        (r) =>
          r.regressionProof?.headSha === 'sha-new' && r.regressionProof.checkPublished === true,
      );

      expect(asked).toEqual(['sha-new']);
      expect(reproved).toMatchObject({ state: 'waiting_human', failureReason: null });
      expect(github.checks).toMatchObject([{ headSha: 'sha-new', conclusion: 'success' }]);
    });

    test('a failing re-proof leaves a failing check and its finding on the run', async () => {
      const factoryId = await enableFactory();
      const run = await seedAutoMergeRun(factoryId);
      const { poll, github } = await watch({
        issues: [],
        github: { head: { sha: 'sha-new', autoMerge: true } },
        proof: provingAs('fail', []),
      });

      await poll.ticks[0]!();
      const failed = await eventuallyRun(run.id, (r) => r.regressionProof?.checkPublished === true);

      expect(failed.failureReason).toContain('Regression proof failed on the new head sha-new');
      expect(failed.failureReason).toContain('The tests pass on the base commit');
      expect(github.checks).toMatchObject([{ headSha: 'sha-new', conclusion: 'failure' }]);
    });

    for (const [why, head] of [
      ['auto-merge is off', { sha: 'sha-new', autoMerge: false }],
      ['the head is still the proved commit', { sha: 'sha-old', autoMerge: true }],
    ] as const) {
      test(`nothing is proved again when ${why}`, async () => {
        const factoryId = await enableFactory();
        await seedAutoMergeRun(factoryId);
        const asked: string[] = [];
        const { poll, github } = await watch({
          issues: [],
          github: { head },
          proof: provingAs('pass', asked),
        });
        await poll.ticks[0]!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(asked).toEqual([]);
        expect(github.checks).toEqual([]);
      });
    }
  });

  describe('a re-proof that cannot be trusted or published (review of task 4.4)', () => {
    async function seedAutoMergeRun(factoryId: string) {
      const run = await seedRun(factoryId, 'waiting_human', ['t-1']);
      await createFactoryRunsRepository().update(run.id, {
        prUrl: 'https://github.com/o/r/pull/9',
        currentStep: null,
        regressionProof: { headSha: 'sha-old', verdict: 'pass', ranAt: '2026-11-22T10:00:00Z' },
      });
      return run;
    }

    /** A runner whose verdict names `answered`, whatever it was asked for. */
    const proving = (asked: string[], answered?: string) => () => ({
      startProof: async (_threadId: string, body: Record<string, unknown>) => {
        asked.push(String(body.headSha));
        return ok({ proofId: 'p1', state: 'running' });
      },
      pollProof: async () =>
        ok({ state: 'done', result: { verdict: 'skipped', headSha: answered ?? asked.at(-1) } }),
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

    test('an issue that cannot be read publishes nothing: its labels must not exempt the test', async () => {
      const factoryId = await enableFactory();
      const run = await seedAutoMergeRun(factoryId);
      const asked: string[] = [];
      const { poll, github } = await watch({
        issues: [],
        github: { head: { sha: 'sha-new', autoMerge: true }, issuesUnreadable: true },
        proof: proving(asked),
      });

      await poll.ticks[0]!();
      await settle();

      expect(asked).toEqual([]);
      expect(github.checks).toEqual([]);
      expect((await runById(run.id)).regressionProof?.headSha).toBe('sha-old');
    });

    test('a verdict of another commit than the one asked for is not recorded or published', async () => {
      const factoryId = await enableFactory();
      const run = await seedAutoMergeRun(factoryId);
      const asked: string[] = [];
      const { poll, github } = await watch({
        issues: [],
        github: { head: { sha: 'sha-new', autoMerge: true } },
        proof: proving(asked, 'sha-other'),
      });

      await poll.ticks[0]!();
      await settle();

      expect(asked).toEqual(['sha-new']);
      expect(github.checks).toEqual([]);
      expect((await runById(run.id)).regressionProof?.headSha).toBe('sha-old');
    });

    for (const [where, inSandbox, fetchHead] of [
      ['on a host runner is not fetched', undefined, false],
      ['in a sandbox is fetched', async () => true, true],
    ] as const) {
      test(`a head pushed from elsewhere ${where}`, async () => {
        const factoryId = await enableFactory();
        await seedAutoMergeRun(factoryId);
        const bodies: Array<Record<string, unknown>> = [];
        const { poll } = await watch({
          issues: [],
          github: { head: { sha: 'sha-new', autoMerge: true } },
          runsPushedCommits: inSandbox,
          proof: () => ({
            startProof: async (_threadId: string, body: Record<string, unknown>) => {
              bodies.push(body);
              return ok({ proofId: 'p1', state: 'running' });
            },
            pollProof: async () =>
              ok({ state: 'done', result: { verdict: 'skipped', headSha: 'sha-new' } }),
          }),
        });

        await poll.ticks[0]!();
        await settle();
        expect(bodies).toMatchObject([{ headSha: 'sha-new', fetchHead }]);
      });
    }

    test('a check that could not be published is published on a later tick, without proving again', async () => {
      const factoryId = await enableFactory();
      const run = await seedAutoMergeRun(factoryId);
      const asked: string[] = [];
      const { poll, github } = await watch({
        issues: [],
        github: { head: { sha: 'sha-new', autoMerge: true }, publishFailures: 1 },
        proof: proving(asked),
      });

      await poll.ticks[0]!();
      await settle();
      expect(github.checks).toEqual([]);
      expect((await runById(run.id)).regressionProof).toMatchObject({
        headSha: 'sha-new',
        checkPublished: false,
      });

      await poll.ticks[0]!();
      await settle();
      expect(asked).toEqual(['sha-new']);
      expect(github.checks).toMatchObject([{ headSha: 'sha-new' }]);
      expect((await runById(run.id)).regressionProof?.checkPublished).toBe(true);
    });
  });

  test('a parked run whose pull request a person merged is closed as merged', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    const { poll, cleanups } = await watch({ issues: [], github: { prStates: { 9: 'merged' } } });

    await poll.ticks[0]!();

    expect(await runById(run.id)).toMatchObject({
      state: 'merged',
      currentStep: null,
      failureReason: null,
    });
    // Merged outside the flow: its worktree is cleaned up all the same.
    expect(cleanups).toEqual([{ userId: 'alice', threadIds: ['t-1'] }]);
  });

  test('a parked run whose pull request was closed without a merge is stopped, saying so', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    const { poll, cleanups } = await watch({ issues: [], github: { prStates: { 9: 'closed' } } });

    await poll.ticks[0]!();

    const closed = await runById(run.id);
    expect(closed.state).toBe('stopped');
    // Not merged: the work exists only on its branch, so the worktree stays.
    expect(cleanups).toEqual([]);
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

  /** Make a parked run look parked `days` ago. */
  const parkedDaysAgo = (runId: string, days: number) =>
    testDb.sqlite
      .query('UPDATE factory_runs SET completed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(), runId);

  // A custom flow without a `create_pr` step never records the pull request
  // its agent opened, so the run could only be found by its branch.
  test('a parked run with no recorded pull request is closed by the one on its branch', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-1']);
    const { poll, github } = await watch({
      issues: [],
      github: {
        branchPrs: {
          [factoryRunBranch(run)]: { number: 12, url: 'https://github.com/o/r/pull/12' },
        },
        prStates: { 12: 'merged' },
      },
    });

    await poll.ticks[0]!();

    expect(github.prLookups).toEqual([{ branch: factoryRunBranch(run), state: 'all' }]);
    expect(await runById(run.id)).toMatchObject({
      state: 'merged',
      prUrl: 'https://github.com/o/r/pull/12',
    });
  });

  test('a pull request found open on the branch is recorded and the run keeps waiting', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-1']);
    const { poll, github } = await watch({
      issues: [],
      github: {
        branchPrs: {
          [factoryRunBranch(run)]: { number: 12, url: 'https://github.com/o/r/pull/12' },
        },
      },
    });

    await poll.ticks[0]!();
    await poll.ticks[0]!();

    expect(await runById(run.id)).toMatchObject({
      state: 'waiting_human',
      prUrl: 'https://github.com/o/r/pull/12',
    });
    // Recorded on the first tick: the second reads it instead of searching again.
    expect(github.prLookups).toHaveLength(1);
  });

  test('a parked run with no pull request on its branch keeps waiting', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-1']);
    const { poll } = await watch({ issues: [] });

    await poll.ticks[0]!();

    expect(await runById(run.id)).toMatchObject({ state: 'waiting_human', prUrl: null });
  });

  test('an old parked run with no recorded pull request is not looked up again', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-1']);
    parkedDaysAgo(run.id, 15);
    const { poll, github } = await watch({ issues: [] });

    await poll.ticks[0]!();

    expect(github.prLookups).toEqual([]);
  });

  test('a paused factory still closes a parked run whose pull request a person merged', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedWithPr(factoryId);
    await createFactorySettingsService().save('alice', 'p1', { enabled: false });
    const { poll } = await watch({ issues: [], github: { prStates: { 9: 'merged' } } });

    expect(scheduledFactoryCount()).toBe(1);
    await poll.ticks[0]!();

    expect((await runById(run.id)).state).toBe('merged');
    // Nothing left to close: the paused factory stops polling.
    await poll.ticks[0]!();
    expect(scheduledFactoryCount()).toBe(0);
  });

  test('a paused factory whose parked runs cannot close any more is not polled', async () => {
    const factoryId = await enableFactory();
    const run = await seedParkedRun(factoryId, ['t-1']);
    parkedDaysAgo(run.id, 15);
    await createFactorySettingsService().save('alice', 'p1', { enabled: false });
    await watch({ issues: [] });

    expect(scheduledFactoryCount()).toBe(0);
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
    const { poll, recorded } = await watch({ checkAccess: async () => false });

    await poll.ticks[0]!();

    const [after] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(after).toMatchObject({ id: run.id, state: 'stopped' });
    // The enabler sees why the factory went off (track-funny-actions).
    expect(recorded.map((r) => r.spec)).toContainEqual(
      expect.objectContaining({ kind: 'factory.disabled', userId: 'alice', origin: 'system' }),
    );
  });

  test('a factory whose enabler keeps access records no factory.disabled', async () => {
    await enableFactory();
    const { poll, recorded } = await watch({ checkAccess: async () => true });
    await poll.ticks[0]!();
    expect(recorded.some((r) => r.spec.kind === 'factory.disabled')).toBe(false);
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
    await startWatcherWithProof({
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
    await startWatcherWithProof({
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

// Issue #328: `maxConcurrent` is checked in the same step as the write that
// puts a run in flight, so a Retry or take-over racing an admission cannot
// push the factory over its cap.
describe('factory capacity between admission and run controls (#328)', () => {
  const runsRepo = () => createFactoryRunsRepository();

  const inFlightCount = async (factoryId: string) =>
    (await runsRepo().countActive(factoryId))._unsafeUnwrap();

  async function seedParked(factoryId: string, issueNumber: number, threadId: string) {
    const run = (
      await runsRepo().start({ factoryId, issueNumber, threadIds: [threadId], state: 'working' })
    )._unsafeUnwrap();
    await runsRepo().update(run.id, { state: 'waiting_human' });
    return (await runsRepo().get(run.id))._unsafeUnwrap()!;
  }

  /** A watcher whose GitHub reads of `issue` first run `during` (the member's click). */
  async function watchWithHook(
    issues: FactoryIssue[],
    issue: number,
    during: () => Promise<unknown>,
  ) {
    const poll = fakePoll();
    const launcher = fakeLauncher();
    const github = fakeGithub('o/r', issues);
    const { getIssue, issueBlockers } = github;
    const hooked = <T>(number: number, read: () => ResultAsync<T, any>) =>
      number === issue ? ResultAsync.fromSafePromise(during()).andThen(read) : read();
    github.getIssue = (reader, number) => hooked(number, () => getIssue(reader, number));
    github.issueBlockers = (reader, number) => hooked(number, () => issueBlockers(reader, number));
    await startWatcherWithProof({
      ports,
      github,
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime,
      waitThread: pendingThreads,
      notify: async () => undefined,
    });
    return { poll, launcher };
  }

  test('a Retry during a queued admission takes the slot; the admission is refused', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1, mode: 'manual' });
    const parked = await seedParked(factoryId, 1, 't-p');
    const queued = (
      await runsRepo().enqueue({ factoryId, issueNumbers: [2], flowName: 'issue-to-merge' })
    )._unsafeUnwrap().queued[0]!;
    let retried: Awaited<ReturnType<ReturnType<typeof createFactoryRunControl>['retry']>> | null =
      null;
    const { poll, launcher } = await watchWithHook([], 2, async () => {
      retried ??= await createFactoryRunControl().retry(factoryId, parked.id);
    });

    await poll.ticks[0]!();

    expect(retried!.isOk()).toBe(true);
    expect((await runsRepo().get(parked.id))._unsafeUnwrap()!.state).toBe('queued');
    expect((await runsRepo().get(queued.id))._unsafeUnwrap()!.state).toBe('requested');
    expect(launcher.calls).toHaveLength(0);
    expect(await inFlightCount(factoryId)).toBe(1);
  });

  test('a Retry during a label admission takes the slot; no second run starts', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1 });
    const parked = await seedParked(factoryId, 1, 't-p');
    let retried = false;
    const { poll, launcher } = await watchWithHook(
      [{ number: 3, title: 'c', url: 'u/3' }],
      3,
      async () => {
        if (retried) return;
        retried = true;
        (await createFactoryRunControl().retry(factoryId, parked.id))._unsafeUnwrap();
      },
    );

    await poll.ticks[0]!();

    expect(retried).toBe(true);
    expect(launcher.calls).toHaveLength(0);
    const all = (await runsRepo().list(factoryId))._unsafeUnwrap();
    expect(all.map((r) => r.issueNumber)).toEqual([1]);
    expect(await inFlightCount(factoryId)).toBe(1);
  });

  test('a Retry on a full factory is refused and the run stays parked', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1 });
    (await runsRepo().start({ factoryId, issueNumber: 1, state: 'working' }))._unsafeUnwrap();
    const failed = (
      await runsRepo().start({ factoryId, issueNumber: 2, state: 'failed' })
    )._unsafeUnwrap();

    const retried = await createFactoryRunControl().retry(factoryId, failed.id);

    expect(retried.isErr() && retried.error.kind).toBe('conflict');
    expect(retried.isErr() && retried.error.message).toContain('as many runs as it may');
    expect((await runsRepo().get(failed.id))._unsafeUnwrap()!.state).toBe('failed');
    expect(await inFlightCount(factoryId)).toBe(1);
  });

  test('a take-over on a full factory waits: the run stays parked until a slot frees', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1 });
    const working = (
      await runsRepo().start({ factoryId, issueNumber: 1, state: 'working' })
    )._unsafeUnwrap();
    const parked = await seedParked(factoryId, 2, 't-take');
    testDb.sqlite
      .query('UPDATE factory_runs SET completed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), parked.id);
    noteOwnerFollowUp('t-take');

    await onFactoryThreadTerminal('t-take', 'completed');

    expect((await runsRepo().get(parked.id))._unsafeUnwrap()!.state).toBe('waiting_human');
    expect(await inFlightCount(factoryId)).toBe(1);

    // The working run ends; the follow-up's next completion takes the run over.
    await runsRepo().update(working.id, { state: 'merged' });
    await onFactoryThreadTerminal('t-take', 'completed');
    expect((await runsRepo().get(parked.id))._unsafeUnwrap()!.state).toBe('queued');
  });

  test('concurrent Retries never put more runs in flight than maxConcurrent', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 2 });
    const failed = await Promise.all(
      [1, 2, 3, 4].map(async (issueNumber) =>
        (await runsRepo().start({ factoryId, issueNumber, state: 'failed' }))._unsafeUnwrap(),
      ),
    );
    const control = createFactoryRunControl();

    const results = await Promise.all(failed.map((run) => control.retry(factoryId, run.id)));

    expect(results.filter((r) => r.isOk())).toHaveLength(2);
    expect(await inFlightCount(factoryId)).toBe(2);
  });
});
