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
  REOPENED_STEP,
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
  passingReview,
  proofReadyFlowFiles,
  upToDateSteps,
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

const originalStartWatcher = startFactoryWatcher;
const startWatcherWithProof: typeof startFactoryWatcher = (d) =>
  originalStartWatcher({
    proof: passingProof,
    steps: upToDateSteps,
    lastThreadMessage: passingReview,
    ...d,
  });

/** Fake poll: captures each factory's tick so the test can fire it. */
function fakePoll() {
  const ticks: Array<() => Promise<void>> = [];
  const createPoll: CreatePoll = (onTick) => {
    ticks.push(onTick);
    return { stop: () => {} };
  };
  return { ticks, createPoll };
}

/** Reviewer threads the fake launchers started, across a test file (unique thread ids). */
let reviewerThreads = 0;

/**
 * A read-only agent's launch, the reviewer's or triage's (change
 * factory-agent-roles): a thread row that already
 * completed, so the real thread wait sees it finished; `passingReview` is what
 * it says. Kept out of `calls`, which count the implementing agent's launches.
 */
function launchReviewer(input: StartThreadInput): LaunchResult {
  const kind = String(input.body.title).startsWith('[Factory triage]') ? 'tri' : 'rev';
  const id = `${kind}-${++reviewerThreads}`;
  seedThread(testDb.db, {
    id,
    projectId: String(input.body.projectId),
    userId: input.userId,
    title: String(input.body.title),
    status: 'completed',
    source: 'factory',
  });
  return launchedThread(id);
}

/** The implementing agent's launch (`[Factory] #N …`), not a read-only agent's. */
const isImplementerLaunch = (input: StartThreadInput) =>
  String(input.body.title).startsWith('[Factory] ');

const isReviewerLaunch = (input: StartThreadInput) =>
  /^\[Factory (review|triage)\]/.test(String(input.body.title));

/** Fake launcher recording calls; succeeds with a thread id per call. */
function fakeLauncher(result: 'ok' | 'offline' = 'ok') {
  const calls: StartThreadInput[] = [];
  const launch = async (input: StartThreadInput): Promise<LaunchResult> => {
    if (result === 'ok' && isReviewerLaunch(input)) return launchReviewer(input);
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
  /** The checks of the base branch (default: green). */
  baseCi?: CiState;
  /** When each issue last changed (GitHub's `updated_at`); an absent one never changed. */
  updated?: Record<number, string>;
  /** Each pull request's state, by number; an absent one is open. */
  prStates?: Record<number, 'open' | 'merged' | 'closed'>;
  /** The pull request on each branch in any state (lookups with `state: 'all'`). */
  branchPrs?: Record<string, { number: number; url: string }>;
  /** Whether the run's branch has commits the default branch does not (default true). */
  branchAhead?: boolean;
  /** A "no change" cleanup finds unsaved work in the run's worktree and keeps it. */
  unsavedWork?: boolean;
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
  /** Label swaps on issues (a run that ended with no change). */
  relabels: Array<{ issue: number; remove?: string; add?: string }>;
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
    relabels: [],
    checks: [],
    prLookups: [],
    resolveRepo: async () => repo,
    // An issue whose label was taken off is no longer listed, as on GitHub.
    listReadyIssues: () =>
      okAsync(issues.filter((i) => !port.relabels.some((r) => r.issue === i.number && r.remove))),
    getIssue: (_reader: unknown, number: number) =>
      script.issuesUnreadable
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync({
            number,
            // A listed issue reads back as listed: a labelled issue is admitted from the queue.
            title: issues.find((i) => i.number === number)?.title ?? `Issue ${number}`,
            url: issues.find((i) => i.number === number)?.url ?? `u/${number}`,
            state: script.closed?.includes(number) ? ('closed' as const) : ('open' as const),
            pullRequest: false,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: script.updated?.[number] ?? '2026-01-01T00:00:00Z',
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
    defaultBranchHead: () => okAsync({ branch: 'main', sha: 'head-sha' }),
    readFileAt: (_reader: unknown, path: string) => {
      port.fileReads.push(path);
      const repoFlows = script.builtInFlow ? {} : proofReadyFlowFiles();
      return okAsync({ ...repoFlows, ...script.files }[path] ?? null);
    },
    branchAhead: () => okAsync(script.branchAhead ?? true),
    defaultBranch: () => okAsync('main'),
    branchState: () =>
      okAsync({ sha: 'base-sha', ci: script.baseCi ?? { kind: 'green' as const } }),
    // Merge commits whose checks are unknown: every recent merge stays a suspect.
    mergeCommitState: () => okAsync(null),
    issueText: (_reader: unknown, issue: number) =>
      okAsync({ title: `Issue ${issue}`, body: `The text of issue ${issue}.`, comments: [] }),
    revertPullRequest: () => okAsync({ url: 'https://github.com/o/r/pull/99', number: 99 }),
    relabelIssue: (_reader: unknown, issue: number, labels: { remove?: string; add?: string }) => {
      port.relabels.push({ issue, ...labels });
      return okAsync(undefined);
    },
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
      changedFiles: () => okAsync({ files: [], truncated: false }),
      publishReview: () => okAsync({ status: true }),
      baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
      updateBranch: () => okAsync({ kind: 'updating' as const }),
      commitParents: () => okAsync([]),
      baseChanges: () => okAsync({ commits: [], files: [] }),
      mergeQueueRequired: () => okAsync(false),
      enqueue: () => okAsync({ kind: 'queued' as const }),
      queueState: () => okAsync('merged' as const),
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
const pendingThreads = async (threadId: string, signal: AbortSignal) => {
  // The triage agent finishes (its answer is `passingReview`'s): what never
  // finishes is the work that follows it.
  if (threadId.startsWith('tri-')) return { status: 'completed' as const, output: '' };
  return new Promise<{ status: 'cancelled' }>((resolve) =>
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' })),
  );
};

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
    stageLimits?: Record<string, number>;
  } = {},
) {
  const settings = createFactorySettingsService();
  // Most tests admit labelled issues: automatic mode unless a test says otherwise.
  // One merge at a time: the batched merge queue has its own tests.
  const saved = await settings.save('alice', 'p1', {
    enabled: true,
    mode: 'automatic',
    batch: { size: 1, waitSeconds: 0 },
    ...opts,
  });
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
      // From the remote's default branch, whatever the enabler's checkout is on.
      baseBranch: 'main',
      baseFromRemote: true,
    });
    expect(launcher.calls[0]!.body.prompt).toContain('issue #7 of acme/repo');

    const runsResult = await createFactoryRunsRepository().list(factoryId);
    const runs = runsResult._unsafeUnwrap();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ issueNumber: 7, state: 'working', currentStep: 'implement' });
    expect(runs[0]!.threadIds).toEqual(['t-1']);
  });

  // openspec factory-flow-step-options, 3.4: what ran, and from where.
  test('a run records its flow source and commit, and the options its agent step ran with', async () => {
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

    const [run] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    // The flow was the repository's copy, read at the default branch's head.
    expect(run).toMatchObject({ flowSource: 'repository', flowCommit: 'head-sha' });
    expect(run!.stepOptions).toEqual([
      expect.objectContaining({
        stepId: 'implement',
        threadId: 't-1',
        permissionMode: 'autoEdit',
        thread: 'continue',
      }),
    ]);
    // What the thread was started with is what the run says it ran with.
    expect(launcher.calls[0]!.body).toMatchObject({
      provider: run!.stepOptions[0]!.provider,
      model: run!.stepOptions[0]!.model,
      permissionMode: 'autoEdit',
    });
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
    const triageCalls: Array<Record<string, unknown>> = [];
    await startWatcherWithProof({
      ports,
      github: fakeGithub('acme/repo', [{ number: 7, title: 'Fix it', url: 'u/7' }]),
      createPoll: poll.createPoll,
      launch: launcher.launch,
      resolveRuntime: async () => 'sandbox' as const,
      waitThread: pendingThreads,
      launchSandbox: async (userId, body) => {
        // Triage reads untrusted issue text: it runs in the sandbox too.
        if (String(body.title).startsWith('[Factory triage]')) {
          triageCalls.push(body);
          return ok({ thread: { id: 'tri-s' }, threadId: 'tri-s', runnerId: 'sandbox' });
        }
        sandboxCalls.push({ userId, body });
        return ok({ thread: { id: 's-1' }, threadId: 's-1', runnerId: 'sandbox' });
      },
    });

    await poll.ticks[0]!();

    expect(launcher.calls).toHaveLength(0);
    expect(triageCalls).toHaveLength(1);
    expect(triageCalls[0]).toMatchObject({ permissionMode: 'plan', source: 'factory' });
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
      // The triage agent starts at once; the implementing agent's launch is the slow one.
      if (isReviewerLaunch(input)) return launchReviewer(input);
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
    const launch = async (input: StartThreadInput): Promise<LaunchResult> => {
      // The run's first launch (its triage agent): the issue is already taken.
      if (seenDuringLaunch === 'unset') {
        seenDuringLaunch = (
          await createFactoryRunsRepository().activeByIssue(factoryId, 7)
        )._unsafeUnwrap()?.state;
      }
      return isReviewerLaunch(input) ? launchReviewer(input) : launchedThread('t-1');
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

    // Each tick tried the implementing agent once (and its triage before it).
    expect(offline.calls.filter(isImplementerLaunch)).toHaveLength(2);
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

  test('free slots fill together: each launch does not wait for the one before', async () => {
    await enableFactory({ maxConcurrent: 3 });
    const poll = fakePoll();
    const launcher = fakeLauncher();
    // Each first launch answers only once all three flows asked for one: one at a
    // time, the first would hold the tick for ADMIT_WAIT_MS (past the test's timeout).
    let asked = 0;
    let allAsked: () => void = () => {};
    const together = new Promise<void>((resolve) => (allAsked = resolve));
    const launch = async (input: StartThreadInput) => {
      if (++asked === 3) allAsked();
      await together;
      return launcher.launch(input);
    };
    await startWatcherWithProof({
      ports,
      github: fakeGithub('acme/repo', [
        { number: 1, title: 'a', url: 'u/1' },
        { number: 2, title: 'b', url: 'u/2' },
        { number: 3, title: 'c', url: 'u/3' },
      ]),
      createPoll: poll.createPoll,
      launch,
      resolveRuntime,
      waitThread: pendingThreads,
    });

    await poll.ticks[0]!();

    expect(asked).toBeGreaterThanOrEqual(3);
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

  // Change factory-agent-roles, phase 2: triage, through the real watcher.
  describe('triage', () => {
    const json = (value: unknown) => ['```json', JSON.stringify(value), '```'].join('\n');
    const asks = json({ decision: 'needs_info', questions: ['Which endpoint is slow?'] });
    const readyFor = (paths: string[]) =>
      json({
        decision: 'ready',
        contract: { acceptanceCriteria: ['It works'], likelyPaths: paths },
      });
    const issues = [
      { number: 1, title: 'a', url: 'u/1' },
      { number: 2, title: 'b', url: 'u/2' },
    ];
    const implementing = (launcher: ReturnType<typeof fakeLauncher>) =>
      launcher.calls.filter(isImplementerLaunch).map((call) => call.body.title);
    const runOf = async (factoryId: string, issue: number) =>
      (await createFactoryRunsRepository().list(factoryId))
        ._unsafeUnwrap()
        .find((run) => run.issueNumber === issue)!;

    /** A watcher whose triage agent says `says(threadId)`; the work after it never finishes. */
    async function watching(
      script: GithubScript,
      says: (threadId: string) => string,
      listed = issues.slice(0, 1),
    ) {
      const factoryId = await enableFactory({ maxConcurrent: 2 });
      const poll = fakePoll();
      const launcher = fakeLauncher();
      const github = fakeGithub('acme/repo', listed, script);
      await startWatcherWithProof({
        ports,
        github,
        createPoll: poll.createPoll,
        launch: launcher.launch,
        resolveRuntime,
        waitThread: pendingThreads,
        lastThreadMessage: async (threadId) =>
          threadId.startsWith('tri-') ? says(threadId) : null,
      });
      return { factoryId, poll, launcher, github };
    }

    test('an ambiguous issue gets one comment, holds no slot and starts no implementing agent', async () => {
      const { factoryId, poll, launcher, github } = await watching({}, () => asks);
      await poll.ticks[0]!();

      const run = await runOf(factoryId, 1);
      expect(run.state).toBe('needs_info');
      expect(run.triage).toMatchObject({
        decision: 'needs_info',
        items: ['Which endpoint is slow?'],
      });
      expect(github.comments).toHaveLength(1);
      expect(github.comments[0]).toMatchObject({ issue: 1 });
      expect(implementing(launcher)).toEqual([]);
      expect((await createFactoryRunsRepository().countActive(factoryId))._unsafeUnwrap()).toBe(0);
    });

    test('the label does not start a second run, and an unchanged issue is not triaged again', async () => {
      const { factoryId, poll, github } = await watching({}, () => asks);
      await poll.ticks[0]!();
      await poll.ticks[0]!();
      await poll.ticks[0]!();

      const runs = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.state).toBe('needs_info');
      // Still the one comment, and the one triage.
      expect(github.comments).toHaveLength(1);
    });

    test('the author answers: the issue is triaged again and, now clear, worked', async () => {
      const script: GithubScript = {};
      let answer = asks;
      const { factoryId, poll, launcher } = await watching(script, () => answer);
      await poll.ticks[0]!();
      expect((await runOf(factoryId, 1)).state).toBe('needs_info');

      // A comment on the issue moves its update time; triage now finds it clear.
      script.updated = { 1: '2030-01-01T00:00:00Z' };
      answer = readyFor([]);
      await poll.ticks[0]!();

      const run = await eventually(factoryId, (r) => r.threadIds.length > 0);
      expect(run.state).toBe('working');
      expect(run.triage).toMatchObject({ decision: 'ready' });
      expect(implementing(launcher)).toHaveLength(1);
      // A second triage on its own thread: the first one's answer is not read again.
      const triageThreads = testDb.sqlite
        .query("SELECT COUNT(*) AS n FROM threads WHERE title LIKE '[Factory triage]%'")
        .get() as { n: number };
      expect(triageThreads.n).toBe(2);
      // The same run, not a second one.
      expect((await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap()).toHaveLength(1);
    });

    test('two issues that touch the same file run one after the other, the second without a new triage', async () => {
      const { factoryId, poll, launcher } = await watching(
        {},
        () => readyFor(['src/db/migrate.ts']),
        issues,
      );
      await poll.ticks[0]!();

      // The first works; the second waits in the queue, with its contract and the reason.
      expect(implementing(launcher)).toEqual(['[Factory] #1 a']);
      const waiting = await runOf(factoryId, 2);
      expect(waiting.state).toBe('requested');
      expect(waiting.waitReason).toEqual({ kind: 'paths-overlap', blockers: [1] });
      expect(waiting.triage).toMatchObject({ decision: 'ready' });
      const triages = () =>
        testDb.sqlite
          .query("SELECT COUNT(*) AS n FROM threads WHERE title LIKE '[Factory triage]%'")
          .get() as { n: number };
      expect(triages().n).toBe(2);

      // Still waiting while the first works.
      await poll.ticks[0]!();
      expect(implementing(launcher)).toEqual(['[Factory] #1 a']);

      // The first leaves those states: the second starts, with the contract it already has.
      const first = await runOf(factoryId, 1);
      await createFactoryRunsRepository().update(first.id, { state: 'waiting_human' });
      await poll.ticks[0]!();
      // Admitted from the queue, the second run's thread is named from the issue as it is now.
      expect(implementing(launcher)).toEqual(['[Factory] #1 a', '[Factory] #2 b']);
      expect(triages().n).toBe(2);
    });

    test('issues that touch different files work at once', async () => {
      const { poll, launcher } = await watching(
        {},
        (threadId) => readyFor([`src/${threadId}.ts`]),
        issues,
      );
      await poll.ticks[0]!();
      expect(implementing(launcher)).toEqual(['[Factory] #1 a', '[Factory] #2 b']);
    });
  });

  // Change factory-agent-roles, D10: a broken base branch pauses admissions.
  describe('an incident', () => {
    const red: CiState = {
      kind: 'failing',
      checks: [{ name: 'test', conclusion: 'failure', excerpt: 'expected 3, got 2' }],
    };

    /** A factory with a run merged just now, and one labelled issue waiting. */
    async function afterAMerge(script: GithubScript) {
      const factoryId = await enableFactory();
      const runs = createFactoryRunsRepository();
      const merged = (await runs.start({ factoryId, issueNumber: 1 }))._unsafeUnwrap();
      await runs.update(merged.id, {
        state: 'merged',
        prUrl: 'https://github.com/acme/repo/pull/9',
      });
      const poll = fakePoll();
      const launcher = fakeLauncher();
      const notices: Array<{ userId: string; body: string }> = [];
      await startWatcherWithProof({
        ports,
        github: fakeGithub('acme/repo', [{ number: 2, title: 'b', url: 'u/2' }], script),
        createPoll: poll.createPoll,
        launch: launcher.launch,
        resolveRuntime,
        waitThread: pendingThreads,
        notify: async (userId, notice) => notices.push({ userId, body: notice.body }),
      });
      const blockedReason = async () =>
        (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap()?.blockedReason;
      const sentinels = () =>
        launcher.calls.filter((call) => /^\[Factory sentinel\]/.test(String(call.body.title)));
      return { factoryId, poll, launcher, blockedReason, sentinels };
    }

    test('the base branch red after a merge: no issue is admitted, and a sentinel starts', async () => {
      const { poll, launcher, blockedReason, sentinels } = await afterAMerge({ baseCi: red });
      await poll.ticks[0]!();

      expect(launcher.calls.filter(isImplementerLaunch)).toEqual([]);
      expect(sentinels()).toHaveLength(1);
      expect(sentinels()[0]!.body).toMatchObject({ permissionMode: 'plan' });
      expect(await blockedReason()).toContain('Incident: the base branch main of acme/repo is red');
      // Still paused on the next tick, with the one incident and the one sentinel.
      await poll.ticks[0]!();
      expect(launcher.calls.filter(isImplementerLaunch)).toEqual([]);
      expect(sentinels()).toHaveLength(1);
    });

    test('the base branch green again: the incident closes and the issue is admitted', async () => {
      const script: GithubScript = { baseCi: red };
      const { poll, launcher, blockedReason } = await afterAMerge(script);
      await poll.ticks[0]!();
      expect(launcher.calls.filter(isImplementerLaunch)).toEqual([]);

      script.baseCi = { kind: 'green' };
      await poll.ticks[0]!();
      expect(launcher.calls.filter(isImplementerLaunch).map((call) => call.body.title)).toEqual([
        '[Factory] #2 b',
      ]);
      expect(await blockedReason()).toBeNull();
    });

    test('a green base branch after a merge admits as usual', async () => {
      const { poll, launcher, sentinels } = await afterAMerge({});
      await poll.ticks[0]!();
      expect(launcher.calls.filter(isImplementerLaunch)).toHaveLength(1);
      expect(sentinels()).toEqual([]);
    });
  });

  // Change factory-agent-roles, D13: the factory's own limit for a stage.
  test('a stage limit of one: the second run waits for the implement slot while the first works', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 2, stageLimits: { implement: 1 } });
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

    // Both issues are admitted (two runs in flight), one agent is working.
    const runs = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(runs).toHaveLength(2);
    expect(launcher.calls).toHaveLength(1);
    const waiters = testDb.sqlite
      .query('SELECT group_key, holder FROM workflow_concurrency_waiters')
      .all() as Array<{ group_key: string; holder: string }>;
    expect(waiters.map((waiter) => waiter.group_key)).toEqual([`implement:${factoryId}`]);
  });

  test('without a stage limit both runs work at once', async () => {
    await enableFactory({ maxConcurrent: 2 });
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

    expect(launcher.calls).toHaveLength(2);
  });

  // Change factory-agent-roles, D8: waiting for the repository's merge slot is in
  // flight, so a full merge lane slows admissions instead of piling up pull requests.
  test('runs waiting for the merge slot hold their slots: no issue is admitted', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 2 });
    const runs = createFactoryRunsRepository();
    for (const issueNumber of [1, 2]) {
      const run = (await runs.start({ factoryId, issueNumber }))._unsafeUnwrap();
      await runs.update(run.id, { state: 'merging' });
    }
    const issues = [
      { number: 1, title: 'a', url: 'u/1' },
      { number: 2, title: 'b', url: 'u/2' },
      { number: 3, title: 'c', url: 'u/3' },
    ];
    const start = async () => {
      const poll = fakePoll();
      const launcher = fakeLauncher();
      await startWatcherWithProof({
        ports,
        github: fakeGithub('acme/repo', issues),
        createPoll: poll.createPoll,
        launch: launcher.launch,
        resolveRuntime,
        waitThread: pendingThreads,
      });
      await poll.ticks[0]!();
      return launcher.calls.map((call) => call.body.title);
    };

    expect(await start()).not.toContain('[Factory] #3 c');

    // One of them parks for a person: its slot is free and the next issue comes in.
    stopFactoryWatcher();
    const [first] = (await runs.inFlight(factoryId))._unsafeUnwrap();
    await runs.update(first!.id, { state: 'waiting_human' });
    expect(await start()).toContain('[Factory] #3 c');
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
    /** What a thread's last message is (a reviewer's verdict); default: every review passes. */
    lastThreadMessage: (threadId: string) => Promise<string | null> = passingReview,
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
      lastThreadMessage,
      cleanupMerged: async (userId, threadIds) => {
        cleanups.push({ userId, threadIds });
      },
      cleanupUnchanged: async (userId, threadIds) => {
        cleanups.push({ userId, threadIds });
        return script.unsavedWork
          ? [
              {
                threadId: 't-1',
                worktreePath: '/wt/t-1',
                dirtyFileCount: 3,
                unpushedCommitCount: 0,
              },
            ]
          : [];
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
    // The implementing thread's worktree, the triage agent's and the reviewer's.
    expect(cleanups).toEqual([
      {
        userId: 'alice',
        threadIds: ['t-1', expect.stringMatching(/^tri-\d+$/), expect.stringMatching(/^rev-\d+$/)],
      },
    ]);
  });

  // Change factory-agent-roles, D8: the server merges by rule and asks no agent
  // about a failure that is not code.
  test('a merge a branch rule refuses leaves the run for a person and starts no agent', async () => {
    const { factoryId, github, followUps, launcher } = await runFlow(
      {
        merge: {
          kind: 'not-mergeable',
          reason: 'At least 1 approving review is required by reviewers with write access.',
        },
      },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(run.currentStep).toBe('merge');
    expect(run.failureReason).toContain('At least 1 approving review is required');
    expect(github.merges).toBe(1);
    // Nobody was asked to fix it: no follow-up to the implementer, no new thread.
    expect(followUps).toEqual([]);
    expect(launcher.calls).toHaveLength(1);
  });

  // Change factory-agent-roles: the review gate, through the real flow runner.
  test('a review that keeps failing sends its findings to the implementer, then leaves the run for a person', async () => {
    const failing = [
      '```json',
      JSON.stringify({
        sha: 'sha-head',
        verdict: 'fail',
        findings: [{ severity: 'high', title: 'Negative numbers are dropped', path: 'src/sum.ts' }],
      }),
      '```',
    ].join('\n');
    const { factoryId, github, followUps, launcher } = await runFlow(
      {},
      finishedThreads('completed'),
      // Triage is ready; the reviewer fails the change.
      async (id) => (id.startsWith('tri-') ? passingReview(id) : failing),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(github.merges).toBe(0);
    expect(run.currentStep).toBe('review');
    expect(run.failureReason).toContain('loop exhausted');
    expect(run.reviews).toMatchObject([{ sha: 'sha-head', verdict: 'fail' }]);
    // One implementing thread; the findings reached it as follow-ups, twice (three reviews).
    expect(launcher.calls).toHaveLength(1);
    expect(followUps).toHaveLength(2);
    expect(followUps.every((f) => f.threadId === 't-1')).toBe(true);
    expect(followUps[0]!.content).toContain('[high] src/sum.ts: Negative numbers are dropped');
    // The reviewer is never a step of the implementing thread.
    expect(run.threadIds.every((id) => id === 't-1')).toBe(true);
  });

  test('a reviewer that answers in prose leaves the run for a person: "review gave no verdict"', async () => {
    const { factoryId, github } = await runFlow({}, finishedThreads('completed'), async (id) =>
      id.startsWith('tri-') ? passingReview(id) : 'The change looks fine to me.',
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(run.failureReason).toBe('review gave no verdict');
    expect(run.currentStep).toBe('review');
    expect(github.merges).toBe(0);
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

  // Issue #236: an index issue with nothing to change stayed "waiting for you"
  // at the pull-request step, as if its run had failed.
  test('an agent that rightly changed nothing ends the run as no_change and hands the issue back', async () => {
    const { factoryId, github, cleanups, poll, launcher, notices } = await runFlow(
      { pr: false, branchAhead: false },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'no_change');
    expect(run.failureReason).toBeNull();
    expect(run.currentStep).toBe('pull-request');
    expect(run.completedAt).not.toBeNull();
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.issue).toBe(7);
    expect(github.comments[0]!.body).toStartWith(NO_CHANGE_LINE);
    expect(cleanups).toEqual([{ userId: 'alice', threadIds: ['t-1'] }]);
    expect(github.merges).toBe(0);
    // Out of the label queue and marked for a person; nobody is told to act.
    expect(github.relabels).toEqual([{ issue: 7, remove: 'ready-for-agent', add: 'needs-triage' }]);
    expect(notices).toEqual([]);
    // Even if the label stayed, a later tick does not admit the issue again.
    await poll.ticks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launcher.calls).toHaveLength(1);
    const all = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(all).toHaveLength(1);
  });

  test('a "no change" run that left unsaved work waits for a person and keeps its label', async () => {
    const { factoryId, github, poll, launcher } = await runFlow(
      { pr: false, branchAhead: false, unsavedWork: true },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'waiting_human');
    expect(run.failureReason).toBe('no change');
    expect(run.currentStep).toBe('pull-request');
    expect(github.comments[0]!.body).toContain('/wt/t-1');
    expect(github.relabels).toEqual([]);
    // Parked, it still holds its issue: a later tick does not admit it again.
    await poll.ticks[0]!();
    expect(launcher.calls).toHaveLength(1);
  });

  test('a run that ended as no_change can be retried with a new agent', async () => {
    const { factoryId, launcher } = await runFlow(
      { pr: false, branchAhead: false },
      finishedThreads('completed'),
    );
    const run = await eventually(factoryId, (r) => r.state === 'no_change');

    const retried = await createFactoryRunControl().retry(factoryId, run.id);

    expect(retried._unsafeUnwrap()).toMatchObject({ state: 'queued', threadIds: [] });
    await eventually(factoryId, () => launcher.calls.length === 2);
  });

  // Issue #343: the factory thread shows the run's step chain and why it
  // failed, which were only in the server log.
  test('a failed run records its flow steps, the step it failed at and why', async () => {
    const { factoryId } = await runFlow({ pr: false }, finishedThreads('completed'));
    const run = await eventually(factoryId, (r) => r.state === 'failed');
    expect(run.flowSteps).toEqual([
      'triage',
      'implement',
      'pull-request',
      'integrate',
      'address',
      'regression-proof',
      'ci',
      'review',
      'merge',
    ]);
    expect(run.currentStep).toBe('pull-request');
    expect(run.failureReason).toContain('No open pull request');
  });

  describe('admission needs a proof-ready flow (task 4.6)', () => {
    const blocked = async () =>
      (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap()!.blockedReason;
    const runsOf = async (factoryId: string) =>
      (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();

    /** The issue waits in the queue, saying why. */
    const waitingForRules = (runs: FactoryRunView[]) =>
      runs.map((run) => ({ state: run.state, wait: run.waitReason?.kind }));

    test('the built-in flow, with no proof rules, admits nothing and says why', async () => {
      const { factoryId, launcher } = await runFlow({ builtInFlow: true }, pendingThreads);
      expect(waitingForRules(await runsOf(factoryId))).toEqual([
        { state: 'requested', wait: 'proof-not-configured' },
      ]);
      expect(launcher.calls).toHaveLength(0);
      expect(await blocked()).toContain('Regression proof not configured');
    });

    test('once rules are added the issue is admitted and the blocker clears', async () => {
      const script: GithubScript = { builtInFlow: true };
      const { factoryId, poll } = await runFlow(script, pendingThreads);
      expect(waitingForRules(await runsOf(factoryId))).toEqual([
        { state: 'requested', wait: 'proof-not-configured' },
      ]);
      script.builtInFlow = false;
      await poll.ticks[0]!();
      const [run, ...others] = await runsOf(factoryId);
      expect(others).toEqual([]);
      expect(run!.state).not.toBe('requested');
      expect(await blocked()).toBeNull();
    });

    test('a merge that opts out of the proof is admitted without rules', async () => {
      const flowFiles = proofReadyFlowFiles();
      const optOut = flowFiles['.funny/workflows/issue-to-merge.yaml']!.replace(
        /      rules:\n.*\n.*\n/,
        '',
      ).replace('    merge:', '    merge:\n      require_regression_proof: false');
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
    expect(run.flowSteps).toEqual([
      'triage',
      'implement',
      'pull-request',
      'integrate',
      'address',
      'regression-proof',
      'ci',
      'review',
      'merge',
    ]);
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
      // No concurrency here: the factory puts every merge in the repository's lane.
      '    merge: { method: squash, require_regression_proof: false, require_review: false }',
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
      // The lane of the repository and its base branch, though the flow declares none.
      expect(lease?.group_key).toBe('merge:o/r:main');
      const [waiter] = rows('workflow_concurrency_waiters');
      expect(waiter?.group_key).toBe('merge:o/r:main');
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

  test('an unknown flow is refused before any agent starts', async () => {
    const factoryId = await enableFactory({ flowName: 'no-such-flow' });
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
      steps: upToDateSteps,
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
    const { poll, launcher, github } = await watch();
    await poll.ticks[0]!();
    const running = await eventually(factoryId, (r) => r.state === 'working');

    const stopped = await createFactoryRunControl().stop('alice', factoryId, running.id);

    expect(stopped._unsafeUnwrap().state).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [after] = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(after!.state).toBe('stopped');
    expect(launcher.calls).toHaveLength(1);
    // Found in the E2E: the label stayed on, and automatic mode took the issue again.
    expect(github.relabels).toContainEqual({ issue: 7, remove: 'ready-for-agent' });
    await poll.ticks[0]!();
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

  test('approving a held high-risk merge records the approved commit and retries the run', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-ok', projectId: 'p1', userId: 'alice', status: 'completed' });
    const run = await seedRun(factoryId, 'waiting_human', ['t-ok']);
    await createFactoryRunsRepository().update(run.id, {
      failureReason: 'high risk',
      risk: {
        headSha: 'c2b585c51b2e',
        level: 'high',
        reasons: ['touches a sensitive path: packages/server/src/db/migrate.ts (**/migrate.ts)'],
        changedLines: 10,
        paths: ['packages/server/src/db/migrate.ts'],
      },
    });

    const approved = await createFactoryRunControl().approveMerge('alice', factoryId, run.id);

    const { run: after, sha } = approved._unsafeUnwrap();
    expect(sha).toBe('c2b585c51b2e');
    expect(after).toMatchObject({ state: 'queued', failureReason: null, threadIds: ['t-ok'] });
    expect(after.mergeApproval).toMatchObject({ sha: 'c2b585c51b2e', userId: 'alice' });
  });

  test('an approval moves to a base merge of the approved commit, and only from that commit', async () => {
    const factoryId = await enableFactory();
    const run = await seedRun(factoryId, 'waiting_human', []);
    const runs = createFactoryRunsRepository();
    await runs.update(run.id, { failureReason: 'high risk' });
    await runs.approveMerge(run.id, { sha: 'a'.repeat(40), userId: 'alice', at: 'now' });

    // From another commit: nothing moves.
    expect(
      (await runs.carryMergeApproval(run.id, 'c'.repeat(40), 'm'.repeat(40)))._unsafeUnwrap(),
    ).toBe(false);
    expect(
      (await runs.carryMergeApproval(run.id, 'a'.repeat(40), 'm'.repeat(40)))._unsafeUnwrap(),
    ).toBe(true);
    // Carried again, it still names the commit the member approved.
    expect(
      (await runs.carryMergeApproval(run.id, 'm'.repeat(40), 'n'.repeat(40)))._unsafeUnwrap(),
    ).toBe(true);
    const after = (await runs.get(run.id))._unsafeUnwrap();
    expect(after?.mergeApproval).toEqual({
      sha: 'n'.repeat(40),
      userId: 'alice',
      at: 'now',
      carriedFrom: 'a'.repeat(40),
    });
  });

  test('only a run held for its high risk can be approved', async () => {
    const factoryId = await enableFactory();
    const failed = await seedRun(factoryId, 'failed', []);
    const parked = (
      await createFactoryRunsRepository().start({
        factoryId,
        issueNumber: 8,
        threadIds: [],
        state: 'waiting_human',
      })
    )._unsafeUnwrap();
    await createFactoryRunsRepository().update(parked.id, { failureReason: 'review failed' });
    const control = createFactoryRunControl();

    for (const run of [failed, parked]) {
      const approved = await control.approveMerge('alice', factoryId, run.id);
      expect(approved.isErr() && approved.error.kind).toBe('conflict');
    }
    const rows = (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();
    expect(rows.map((row) => row.mergeApproval)).toEqual([null, null]);
  });

  test('retrying keeps a completed implement step and runs the later steps again', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-ok', projectId: 'p1', userId: 'alice', status: 'completed' });
    seedThread(testDb.db, { id: 't-fix', projectId: 'p1', userId: 'alice', status: 'completed' });
    const run = await seedRun(factoryId, 'waiting_human', ['t-ok', 't-fix']);

    const retried = await createFactoryRunControl().retry(factoryId, run.id);

    expect(retried._unsafeUnwrap().threadIds).toEqual(['t-ok']);
  });

  // Run #229: the agent ended without committing, the run parked as "no
  // change", and each Retry replayed the finished thread to the same result.
  test('retrying a "no change" run starts a new agent instead of replaying its thread', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-none', projectId: 'p1', userId: 'alice', status: 'completed' });
    const run = await seedRun(factoryId, 'waiting_human', ['t-none']);
    await createFactoryRunsRepository().update(run.id, { failureReason: 'no change' });
    const { launcher } = await watch({ issues: [], waitThread: finishedThreads('completed') });

    const retried = await createFactoryRunControl().retry(factoryId, run.id);

    expect(retried._unsafeUnwrap().threadIds).toEqual([]);
    await eventually(factoryId, (r) => r.state === 'merged');
    expect(launcher.calls).toHaveLength(1);
  });

  // Runs #228 / #229: a retry that started a new agent left the old failed
  // thread in the list under the same title, so deleting "the" run's thread
  // seemed to do nothing.
  test('a retry archives the threads it does not keep', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-old', projectId: 'p1', userId: 'alice', status: 'failed' });
    seedThread(testDb.db, { id: 't-busy', projectId: 'p1', userId: 'alice', status: 'running' });
    const run = await seedRun(factoryId, 'failed', ['t-old', 't-busy']);
    await watch({ issues: [], waitThread: finishedThreads('completed') });

    (await createFactoryRunControl().retry(factoryId, run.id))._unsafeUnwrap();

    const archived = (id: string) =>
      (
        testDb.sqlite.query('SELECT archived FROM threads WHERE id = ?').get(id) as {
          archived: number;
        }
      ).archived;
    expect(archived('t-old')).toBe(1);
    // A thread a member is still running is not taken from them.
    expect(archived('t-busy')).toBe(0);
  });

  test('a retry that keeps the implement thread leaves it in the list', async () => {
    const factoryId = await enableFactory();
    seedThread(testDb.db, { id: 't-ok', projectId: 'p1', userId: 'alice', status: 'completed' });
    seedThread(testDb.db, { id: 't-fix', projectId: 'p1', userId: 'alice', status: 'completed' });
    const run = await seedRun(factoryId, 'waiting_human', ['t-ok', 't-fix']);

    (await createFactoryRunControl().retry(factoryId, run.id))._unsafeUnwrap();

    const rows = testDb.sqlite
      .query("SELECT id, archived FROM threads WHERE id IN ('t-ok', 't-fix') ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 't-fix', archived: 1 },
      { id: 't-ok', archived: 0 },
    ]);
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
    // The labelled issue stays in the queue, waiting for the slot.
    const all = (await runsRepo().list(factoryId))._unsafeUnwrap();
    expect(all.map((r) => [r.issueNumber, r.state]).sort()).toEqual([
      [1, 'queued'],
      [3, 'requested'],
    ]);
    expect(await inFlightCount(factoryId)).toBe(1);
  });

  test('a Retry on a full factory queues the run first in line, without a slot', async () => {
    const factoryId = await enableFactory({ maxConcurrent: 1 });
    (await runsRepo().start({ factoryId, issueNumber: 1, state: 'working' }))._unsafeUnwrap();
    const sent = (
      await runsRepo().enqueue({ factoryId, issueNumbers: [3], flowName: 'issue-to-merge' })
    )._unsafeUnwrap().queued[0]!;
    const failed = (
      await runsRepo().start({ factoryId, issueNumber: 2, state: 'failed', threadIds: ['t-impl'] })
    )._unsafeUnwrap();

    const retried = await createFactoryRunControl().retry(factoryId, failed.id);

    expect(retried.isOk()).toBe(true);
    const run = (await runsRepo().get(failed.id))._unsafeUnwrap()!;
    expect(run.state).toBe('requested');
    expect(run.waitReason).toEqual({ kind: 'no-free-slot', blockers: [] });
    expect(run.currentStep).toBe(REOPENED_STEP);
    expect(await inFlightCount(factoryId)).toBe(1);
    // Ahead of the issue sent before it.
    const queue = (await runsRepo().queue(factoryId))._unsafeUnwrap();
    expect(queue.map((r) => r.id)).toEqual([failed.id, sent.id]);
  });

  test('a take-over on a full factory waits in the queue for the next slot', async () => {
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

    const waiting = (await runsRepo().get(parked.id))._unsafeUnwrap()!;
    expect(waiting.state).toBe('requested');
    expect(waiting.threadIds).toEqual(parked.threadIds);
    expect(await inFlightCount(factoryId)).toBe(1);

    // The working run ends: the queue admits it with its threads to replay.
    await runsRepo().update(working.id, { state: 'merged' });
    expect((await runsRepo().admit(factoryId, parked.id))._unsafeUnwrap()).toBe('admitted');
    expect((await runsRepo().get(parked.id))._unsafeUnwrap()!.currentStep).toBe(REOPENED_STEP);
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

    // Every Retry is taken; the two beyond the limit wait in the queue.
    expect(results.filter((r) => r.isOk())).toHaveLength(4);
    expect(await inFlightCount(factoryId)).toBe(2);
    expect((await runsRepo().queue(factoryId))._unsafeUnwrap()).toHaveLength(2);
  });
});
