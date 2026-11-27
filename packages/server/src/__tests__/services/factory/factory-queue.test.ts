/**
 * The factory queue (change factory-manual-queue): sending chosen issues, the
 * order the queue admits them in, manual vs automatic mode, pause / clear /
 * stop all, the run's own flow, and blocked issues — fake GitHub + fake
 * launcher + fake poll, real test DB.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { IssueBlocker } from '@funny/core/github-app';
import { errAsync, okAsync } from 'neverthrow';

import type { FactoryGithubPort, FactoryIssue } from '../../../services/factory/factory-github.js';
import {
  createFactoryQueue,
  type FactoryQueueDeps,
} from '../../../services/factory/factory-queue.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createFactoryTriggersRepository } from '../../../services/factory/factory-triggers.js';
import {
  type CreatePoll,
  startFactoryWatcher,
  stopFactoryWatcher,
} from '../../../services/factory/factory-watcher.js';
import type { StartThreadInput } from '../../../services/runner-thread-launcher.js';
import {
  launchedThread,
  passingProof,
  upToDateSteps,
  passingReview,
  proofReadyFlowFiles,
  runnerOffline,
  unusedRunnerPorts,
  type LaunchResult,
} from '../../helpers/builders-services.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

interface Script {
  /** Issues the label lists (automatic mode). */
  labelled?: FactoryIssue[];
  closed?: number[];
  pullRequests?: number[];
  missing?: number[];
  /** Creation dates (an issue absent here was created on 2026-01-01). */
  created?: Record<number, string>;
  blockers?: Record<number, IssueBlocker[] | 'unreadable'>;
  /** The repository's `.funny/workflows` file names. */
  repoFlows?: string[];
  /** Default-branch file contents by path. */
  repoFiles?: Record<string, string>;
  /** Reading a default-branch file fails (GitHub cannot be reached). */
  repoUnreadable?: boolean;
  /** The repository cannot be resolved (the runner is offline). */
  noRepo?: boolean;
  /** No GitHub App token can be minted. */
  noToken?: boolean;
  /** The branches GitHub has (a send that names its own branches asks). */
  branches?: string[];
}

/** The fake GitHub port, with the merges and opened issues the test reads back. */
type FakeGithub = FactoryGithubPort & {
  merges: number;
  opened: Array<{ ownerId: string; title: string; body: string }>;
  /** Labels taken off issues. */
  unlabelled: number[];
};

function fakeGithub(script: Script = {}): FakeGithub {
  const port: FakeGithub = {
    merges: 0,
    opened: [],
    unlabelled: [],
    createIssue: (reader, issue) => {
      port.opened.push({ ownerId: reader.ownerId, ...issue });
      return okAsync({ number: 77, url: 'https://github.com/o/r/issues/77' });
    },
    resolveRepo: async () => (script.noRepo ? null : 'o/r'),
    // SAFETY: a send reads only whether a branch exists.
    laneBranches: () =>
      ({
        branchHead: (branch: string) =>
          okAsync(script.branches?.includes(branch) ? `${branch}-head` : null),
      }) as never,
    listReadyIssues: () => okAsync(script.labelled ?? []),
    getIssue: (_reader: unknown, number: number) => {
      if (script.noToken) {
        return errAsync({
          message: 'The GitHub App is not installed on o/r',
          kind: 'not-installed',
        });
      }
      if (script.missing?.includes(number)) {
        return errAsync({ message: 'GitHub answered 404', status: 404 });
      }
      return okAsync({
        number,
        title: `Issue ${number}`,
        url: `u/${number}`,
        state: script.closed?.includes(number) ? ('closed' as const) : ('open' as const),
        pullRequest: script.pullRequests?.includes(number) ?? false,
        createdAt: script.created?.[number] ?? '2026-01-01T00:00:00Z',
      });
    },
    issueBlockers: (_reader: unknown, number: number) => {
      const blockers = script.blockers?.[number] ?? [];
      return blockers === 'unreadable'
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync(blockers);
    },
    listDefaultBranchDir: () => okAsync(script.repoFlows ?? []),
    readDefaultBranchFile: (_reader: unknown, path: string) =>
      script.repoUnreadable
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync({ ...proofReadyFlowFiles(), ...script.repoFiles }[path] ?? null),
    defaultBranchHead: () => okAsync({ branch: 'main', sha: 'head-sha' }),
    readFileAt: (_reader: unknown, path: string) =>
      script.repoUnreadable
        ? errAsync({ message: 'GitHub answered 500', status: 500 })
        : okAsync({ ...proofReadyFlowFiles(), ...script.repoFiles }[path] ?? null),
    branchAhead: () => okAsync(true),
    defaultBranch: () => okAsync('main'),
    branchState: () => okAsync({ sha: 'base-sha', ci: { kind: 'green' as const } }),
    mergeCommitState: () => okAsync(null),
    issueText: () => okAsync({ title: 'Issue', body: '', comments: [] }),
    revertPullRequest: () => okAsync({ url: 'https://github.com/o/r/pull/99', number: 99 }),
    relabelIssue: (_reader, number, change) => {
      if (change.remove) port.unlabelled.push(number);
      return okAsync(undefined);
    },
    commentOnIssue: () => okAsync(undefined),
    findPullRequest: () => okAsync({ number: 9, url: 'https://github.com/o/r/pull/9' }),
    pullRequests: {
      prState: () => okAsync('open' as const),
      changedFiles: () => okAsync({ files: [], truncated: false }),
      publishReview: () => okAsync({ status: true }),
      baseDistance: () => okAsync({ behindBy: 0, aheadBy: 1 }),
      updateBranch: () => okAsync({ kind: 'updating' as const }),
      commitParents: () => okAsync([]),
      baseChanges: () => okAsync({ commits: [], files: [] }),
      mergeQueueRequired: () => okAsync(false),
      enqueue: () => okAsync({ kind: 'queued' as const }),
      queueState: () => okAsync('merged' as const),
      pullHead: () => okAsync({ sha: 'sha-head', baseRef: 'main', autoMerge: false }),
      publishProofCheck: () => okAsync(undefined),
      ciState: () => okAsync({ kind: 'green' as const }),
      merge: () => {
        port.merges++;
        return okAsync({ kind: 'merged', method: 'squash', branchDeleted: true } as const);
      },
    },
  };
  return port;
}

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

const isReviewerLaunch = (input: StartThreadInput) =>
  /^\[Factory (review|triage)\]/.test(String(input.body.title));

function fakeLauncher(result: 'ok' | 'offline' = 'ok') {
  const calls: StartThreadInput[] = [];
  const launch = async (input: StartThreadInput): Promise<LaunchResult> => {
    if (result === 'ok' && isReviewerLaunch(input)) return launchReviewer(input);
    calls.push(input);
    return result === 'ok' ? launchedThread(`t-${calls.length}`) : runnerOffline('offline');
  };
  return { calls, launch, issues: () => calls.map(issueOf) };
}

/** The issue number a launched agent works on (its title is `[Factory] #N …`). */
const issueOf = (call: StartThreadInput) => Number(/#(\d+)/.exec(String(call.body.title))![1]);

/** Agent threads that never finish until the watcher stops. */
const pendingThreads = async (threadId: string, signal: AbortSignal) => {
  // The triage agent finishes (its answer is `passingReview`'s): what never
  // finishes is the work that follows it.
  if (threadId.startsWith('tri-')) return { status: 'completed' as const, output: '' };
  return new Promise<{ status: 'cancelled' }>((resolve) =>
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' })),
  );
};

const finishedThreads = (status: 'completed' | 'failed') => async () => ({
  status,
  output: 'done',
});

const blocker = (number: number, open = true, repo = 'o/r'): IssueBlocker => ({
  number,
  repo,
  open,
});

async function setUp(
  opts: {
    mode?: 'manual' | 'automatic';
    enabled?: boolean;
    maxConcurrent?: number;
    flowName?: string;
    stepOverrides?: Record<string, { provider?: string; model?: string }>;
    dependencies?: 'wait' | 'stack';
    script?: Script;
    launcher?: ReturnType<typeof fakeLauncher>;
    waitThread?: (id: string, signal: AbortSignal) => Promise<any>;
    batches?: FactoryQueueDeps['batches'];
    /** The clock of the schedule triggers (change flow-triggers). */
    now?: () => Date;
  } = {},
) {
  const settings = createFactorySettingsService();
  const saved = await settings.save('alice', 'p1', {
    enabled: opts.enabled ?? true,
    mode: opts.mode,
    maxConcurrent: opts.maxConcurrent,
    flowName: opts.flowName,
    stepOverrides: opts.stepOverrides,
    dependencies: opts.dependencies,
    // One merge at a time: the batched merge queue has its own tests.
    batch: { size: 1, waitSeconds: 0 },
  });
  if (saved.isErr()) throw new Error(saved.error.message);
  const factoryId = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
  const poll = fakePoll();
  const launcher = opts.launcher ?? fakeLauncher();
  const github = fakeGithub(opts.script);
  /** The kinds of the activities the watcher recorded. */
  const activities: string[] = [];
  await startFactoryWatcher({
    ports: unusedRunnerPorts(),
    github,
    createPoll: poll.createPoll,
    launch: launcher.launch,
    resolveRuntime: async () => 'local' as const,
    waitThread: opts.waitThread ?? pendingThreads,
    notify: async () => undefined,
    proof: passingProof,
    steps: upToDateSteps,
    lastThreadMessage: passingReview,
    now: opts.now,
    activities: {
      recordServerActivity: async (activity) => {
        activities.push(activity.kind);
        return undefined as never;
      },
    },
  });
  // The tests fire the tick themselves: a send does not poke the factory here.
  const queue = createFactoryQueue({
    wake: async () => {},
    batches: opts.batches,
    triggers: createFactoryTriggersRepository({
      newId: () => crypto.randomUUID(),
      now: opts.now ?? (() => new Date()),
    }),
  });
  const tick = () => poll.ticks[0]!();
  return { factoryId, queue, launcher, github, tick, activities };
}

const runsOf = async (factoryId: string) =>
  (await createFactoryRunsRepository().list(factoryId))._unsafeUnwrap();

const runFor = async (factoryId: string, issue: number) =>
  (await runsOf(factoryId)).find((run) => run.issueNumber === issue)!;

async function eventually(
  factoryId: string,
  issue: number,
  done: (run: FactoryRunView) => boolean,
): Promise<FactoryRunView> {
  for (let i = 0; i < 200; i++) {
    const run = await runFor(factoryId, issue);
    if (run && done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the run of #${issue} never reached the expected state`);
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

describe('sending issues', () => {
  test('sent issues wait in the queue with the chosen flow', async () => {
    const { factoryId, queue } = await setUp();

    const sent = await queue.submit(factoryId, { issueNumbers: [12, 15], flowName: 'issue-to-pr' });

    expect(sent._unsafeUnwrap()).toEqual({ accepted: [12, 15], refused: [] });
    const runs = await runsOf(factoryId);
    expect(runs.map((r) => [r.issueNumber, r.state, r.source, r.flowName])).toEqual(
      expect.arrayContaining([
        [12, 'requested', 'manual', 'issue-to-pr'],
        [15, 'requested', 'manual', 'issue-to-pr'],
      ]),
    );
  });

  test('a send keeps the branches it chose on its own runs only (D13)', async () => {
    const { factoryId, queue } = await setUp({ script: { branches: ['release', 'qa'] } });

    (
      await queue.submit(factoryId, { issueNumbers: [12], flowName: 'issue-to-pr' })
    )._unsafeUnwrap();
    const sent = await queue.submit(factoryId, {
      issueNumbers: [15],
      flowName: 'issue-to-pr',
      route: { lane: { name: 'pay', baseBranch: 'release', finishBranch: 'qa' } },
    });

    expect(sent._unsafeUnwrap().accepted).toEqual([15]);
    const runs = await runsOf(factoryId);
    expect(runs.find((r) => r.issueNumber === 15)!.requestedRoute).toEqual({
      lane: { name: 'pay', baseBranch: 'release', finishBranch: 'qa' },
    });
    expect(runs.find((r) => r.issueNumber === 12)!.requestedRoute).toBeNull();
  });

  test('a send that names a branch GitHub does not have is refused, and queues nothing', async () => {
    const { factoryId, queue } = await setUp({ script: { branches: ['release'] } });

    const sent = await queue.submit(factoryId, {
      issueNumbers: [12],
      flowName: 'issue-to-pr',
      route: { baseBranch: 'relase' },
    });

    expect(sent._unsafeUnwrapErr()).toMatchObject({
      kind: 'invalid',
      message: 'The branch relase does not exist on GitHub.',
    });
    expect(await runsOf(factoryId)).toEqual([]);
  });

  test('a queued run keeps its issue title, so the board can name it before it has a thread', async () => {
    const { factoryId, queue } = await setUp();

    await queue.submit(factoryId, { issueNumbers: [12], flowName: 'issue-to-pr' });

    expect((await runFor(factoryId, 12))?.issueTitle).toBe('Issue 12');
  });

  test('a new factory starts in manual mode', async () => {
    const { factoryId } = await setUp();
    const settings = (await createFactorySettingsService().get('alice', 'p1'))._unsafeUnwrap();
    expect(settings?.mode).toBe('manual');
    expect(factoryId).toBeTruthy();
  });

  test('closed issues, pull requests and missing issues are refused; the rest queue', async () => {
    const { factoryId, queue } = await setUp({
      script: { closed: [2], pullRequests: [3], missing: [4] },
    });

    const sent = (
      await queue.submit(factoryId, { issueNumbers: [1, 2, 3, 4], flowName: 'issue-to-merge' })
    )._unsafeUnwrap();

    expect(sent.accepted).toEqual([1]);
    expect(sent.refused.map((r) => [r.issue, r.reason])).toEqual([
      [2, 'closed'],
      [3, 'pull-request'],
      [4, 'not-found'],
    ]);
  });

  test('an issue already in the factory is refused and no second run is created', async () => {
    const { factoryId, queue } = await setUp();
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    const again = (
      await queue.submit(factoryId, { issueNumbers: [7, 8], flowName: 'issue-to-merge' })
    )._unsafeUnwrap();

    expect(again.accepted).toEqual([8]);
    expect(again.refused).toMatchObject([{ issue: 7, reason: 'already-in-factory' }]);
    expect((await runsOf(factoryId)).filter((r) => r.issueNumber === 7)).toHaveLength(1);
  });

  test('a paused factory refuses a send and queues nothing', async () => {
    const { factoryId, queue } = await setUp({ enabled: false });

    const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    expect(sent._unsafeUnwrapErr()).toMatchObject({ kind: 'paused' });
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('a factory that cannot reach its repository refuses a send with the reason', async () => {
    const { factoryId, queue } = await setUp({ script: { noRepo: true } });

    const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    const error = sent._unsafeUnwrapErr();
    expect(error.kind).toBe('cannot-work');
    expect(error.message).toContain('runner');
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('without a GitHub App token the whole send is refused', async () => {
    const { factoryId, queue } = await setUp({ script: { noToken: true } });

    const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    expect(sent._unsafeUnwrapErr()).toMatchObject({ kind: 'cannot-work' });
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('an unknown flow is refused', async () => {
    const { factoryId, queue } = await setUp();

    const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName: 'no-such-flow' });
    expect(sent._unsafeUnwrapErr()).toMatchObject({ kind: 'invalid-flow' });
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('the flows a send may pick: built-ins plus the repository flows', async () => {
    const { factoryId, queue } = await setUp({
      script: { repoFlows: ['custom.yaml', 'issue-to-pr.yml', 'README.md'] },
    });

    const flows = (await queue.flows(factoryId))._unsafeUnwrap();

    expect(flows).toEqual([
      { name: 'issue-to-merge', source: 'built-in' },
      { name: 'custom', source: 'repository' },
      { name: 'issue-to-pr', source: 'repository' },
    ]);
  });

  test("a flow's YAML: the repository copy replaces the built-in of its name", async () => {
    const yaml = 'name: issue-to-pr\n';
    const { factoryId, queue } = await setUp({
      script: { repoFiles: { '.funny/workflows/issue-to-pr.yaml': yaml } },
    });

    const definition = (await queue.flowDefinition(factoryId, 'issue-to-pr'))._unsafeUnwrap();

    expect(definition).toEqual({
      name: 'issue-to-pr',
      source: 'repository',
      path: '.funny/workflows/issue-to-pr.yaml',
      yaml,
    });
  });

  test("a flow's YAML falls back to the built-in when the repository cannot be read", async () => {
    const { factoryId, queue } = await setUp({ script: { repoUnreadable: true } });

    const definition = (await queue.flowDefinition(factoryId, 'issue-to-merge'))._unsafeUnwrap();

    expect(definition.source).toBe('built-in');
    expect(definition.path).toBeNull();
  });

  test("a flow's YAML without a factory: built-ins only", async () => {
    const queue = createFactoryQueue({ wake: async () => {} });

    expect((await queue.flowDefinition(null, 'issue-to-pr'))._unsafeUnwrap().source).toBe(
      'built-in',
    );
    expect((await queue.flowDefinition(null, 'custom'))._unsafeUnwrapErr().kind).toBe(
      'invalid-flow',
    );
  });
});

// openspec factory-integration D12: readiness, and the run that adds the queue's CI trigger.
describe('merge queue readiness', () => {
  const CI_ON_QUEUE = {
    repoFlows: ['ci.yml'],
    repoFiles: { '.github/workflows/ci.yml': "on:\n  push:\n    branches: ['factory/queue/**']\n" },
  };

  test('reads the merge driver of the last integration and the median CI of the batches', async () => {
    const { factoryId, queue } = await setUp({
      script: CI_ON_QUEUE,
      batches: { ciDurations: () => okAsync<number[], never>([300_000, 100_000, 200_000]) },
    });
    await createFactoryRunsRepository().enqueue({
      factoryId,
      issueNumbers: [5],
      flowName: 'issue-to-merge',
    });
    const run = await runFor(factoryId, 5);
    await createFactoryRunsRepository().update(run.id, {
      metrics: { ...run.metrics, integrateRounds: 2, weaveIntegrations: 2 },
    });

    const readiness = (await queue.readiness(factoryId))._unsafeUnwrap();

    expect(readiness).toMatchObject({
      queueCi: true,
      mergeDriver: 'weave',
      medianCiMs: 200_000,
      batchWaitMs: 0,
    });
  });

  test('the CI trigger is proposed as an issue the factory runs, opened as the person who asked', async () => {
    const { factoryId, queue, github } = await setUp();

    const proposal = (await queue.proposeQueueCi('bob', factoryId))._unsafeUnwrap();

    expect(proposal).toEqual({
      issueNumber: 77,
      url: 'https://github.com/o/r/issues/77',
      queued: true,
    });
    expect(github.opened).toEqual([
      expect.objectContaining({
        ownerId: 'bob',
        body: expect.stringContaining('factory/queue/**'),
      }),
    ]);
    expect((await runFor(factoryId, 77)).state).toBe('requested');
  });

  test('no issue when CI already runs on the queue branches', async () => {
    const ready = await setUp({ script: CI_ON_QUEUE });
    expect((await ready.queue.proposeQueueCi('alice', ready.factoryId))._unsafeUnwrapErr()).toEqual(
      {
        kind: 'cannot-work',
        message: "CI already runs on the merge queue's branches.",
      },
    );
    expect(ready.github.opened).toEqual([]);
  });

  test('no issue while the factory is paused', async () => {
    const paused = await setUp({ enabled: false });
    expect(
      (await paused.queue.proposeQueueCi('alice', paused.factoryId))._unsafeUnwrapErr().kind,
    ).toBe('paused');
    expect(paused.github.opened).toEqual([]);
  });
});

// openspec factory-flow-step-options, 4.3: Validate flow.
describe('validating a flow', () => {
  test('a broken repository flow answers its parse error, and nothing is started', async () => {
    const { factoryId, queue, launcher } = await setUp({
      script: { repoFiles: { '.funny/workflows/custom.yaml': 'name: custom\nnodes: [oops' } },
    });

    const answer = (await queue.validateFlow(factoryId, 'p1', 'custom'))._unsafeUnwrap();

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.message).toContain('.funny/workflows/custom.yaml');
    expect(answer.problems).toEqual([{ step: 'flow', field: 'flow', message: answer.message }]);
    expect(launcher.calls).toEqual([]);
    expect(await runsOf(factoryId)).toEqual([]);
  });

  test('a refused option answers its step and field', async () => {
    const { factoryId, queue } = await setUp({
      script: {
        repoFiles: {
          '.funny/workflows/custom.yaml':
            'name: custom\nnodes:\n  - id: implement\n    spawn_agent: { prompt: go, permission_mode: ask }\n',
        },
      },
    });

    const answer = (await queue.validateFlow(factoryId, 'p1', 'custom'))._unsafeUnwrap();

    expect(answer).toMatchObject({
      ok: false,
      problems: [{ step: 'implement', field: 'permission_mode' }],
    });
  });

  test('the built-in issue-to-merge is summarized with its steps and their options', async () => {
    const { factoryId, queue } = await setUp({
      stepOverrides: { 'ci.before_retry': { model: 'haiku' }, review: { model: 'opus' } },
    });

    const answer = (await queue.validateFlow(factoryId, 'p1', 'issue-to-merge'))._unsafeUnwrap();

    if (!answer.ok) throw new Error(answer.message);
    expect(answer).toMatchObject({ name: 'issue-to-merge', source: 'repository' });
    expect(answer.steps.map((step) => `${step.id}:${step.kind}`)).toContain('ci:wait_ci');
    expect(answer.agentSteps.find((step) => step.stepId === 'implement')).toMatchObject({
      permissionMode: 'autoEdit',
      thread: 'continue',
      overridden: false,
    });
    expect(answer.agentSteps.find((step) => step.stepId === 'ci.before_retry')).toMatchObject({
      model: 'haiku',
      overridden: true,
    });
    // `review` is a review step kind, not an agent step: its override is unused.
    expect(answer.unusedOverrides).toEqual(['review']);
    // A cheaper model on the continuing thread replays its context: said so.
    expect(answer.warnings.join('\n')).toContain('ci.before_retry');
  });

  // Found in the stacked E2E: test-funny's prompt copy predated stacking, so a stacked run started from main.
  test('a factory that stacks is warned about a repository flow whose prompts never use stack_branch', async () => {
    const custom =
      'name: custom\nnodes:\n  - id: implement\n    spawn_agent: { prompt: Implement the issue. }\n';
    const stacking = await setUp({
      dependencies: 'stack',
      script: { repoFiles: { '.funny/workflows/custom.yaml': custom } },
    });
    const stale = (
      await stacking.queue.validateFlow(stacking.factoryId, 'p1', 'custom')
    )._unsafeUnwrap();
    if (!stale.ok) throw new Error(stale.message);
    expect(stale.warnings.join('\n')).toContain('{{stack_branch}}');
    // The built-in prompts (copied into the repository here) have the stacking sections.
    const current = (
      await stacking.queue.validateFlow(stacking.factoryId, 'p1', 'issue-to-merge')
    )._unsafeUnwrap();
    if (!current.ok) throw new Error(current.message);
    expect(current.warnings.join('\n')).not.toContain('{{stack_branch}}');
  });

  test('a factory that waits for blockers is not warned about stack_branch', async () => {
    const custom =
      'name: custom\nnodes:\n  - id: implement\n    spawn_agent: { prompt: Implement the issue. }\n';
    const { factoryId, queue } = await setUp({
      dependencies: 'wait',
      script: { repoFiles: { '.funny/workflows/custom.yaml': custom } },
    });
    const answer = (await queue.validateFlow(factoryId, 'p1', 'custom'))._unsafeUnwrap();
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.warnings.join('\n')).not.toContain('{{stack_branch}}');
  });

  test('without a factory, a built-in validates with no overrides', async () => {
    const queue = createFactoryQueue({ wake: async () => {} });

    const answer = (await queue.validateFlow(null, 'p1', 'issue-to-pr'))._unsafeUnwrap();

    expect(answer).toMatchObject({
      ok: true,
      source: 'built-in',
      commit: null,
      unusedOverrides: [],
    });
  });
});

describe('the queue', () => {
  test('queued issues wait for free slots, then go in the order they were sent', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({ maxConcurrent: 2 });
    await queue.submit(factoryId, { issueNumbers: [8], flowName: 'issue-to-merge' });
    await queue.submit(factoryId, { issueNumbers: [3], flowName: 'issue-to-merge' });
    await queue.submit(factoryId, { issueNumbers: [5], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.issues()).toEqual([8, 3]);
    expect((await runFor(factoryId, 5)).state).toBe('requested');
  });

  test('issues sent together start oldest first', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      maxConcurrent: 1,
      script: { created: { 30: '2026-03-01T00:00:00Z', 8: '2026-01-01T00:00:00Z' } },
    });
    const sent = await queue.submit(factoryId, {
      issueNumbers: [30, 8],
      flowName: 'issue-to-merge',
    });
    expect(sent._unsafeUnwrap().accepted).toEqual([8, 30]);

    await tick();

    expect(launcher.issues()).toEqual([8]);
  });

  test('manual mode ignores labelled issues', async () => {
    const { factoryId, launcher, tick } = await setUp({
      mode: 'manual',
      script: { labelled: [{ number: 7, title: 'Labelled', url: 'u/7' }] },
    });

    await tick();

    expect(launcher.calls).toHaveLength(0);
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('in automatic mode the queue goes before the label, and sending works', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      mode: 'automatic',
      maxConcurrent: 1,
      script: { labelled: [{ number: 7, title: 'Labelled', url: 'u/7' }] },
    });
    await queue.submit(factoryId, { issueNumbers: [20], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.issues()).toEqual([20]);
    // The labelled issue waits behind it, in the queue, named by its title.
    const labelled = await runFor(factoryId, 7);
    expect(labelled).toMatchObject({ state: 'requested', source: 'label', issueTitle: 'Labelled' });
  });

  test('labelled issues beyond the free slots wait in the queue, oldest first', async () => {
    const labelled = [7, 8, 9].map((number) => ({
      number,
      title: `L${number}`,
      url: `u/${number}`,
    }));
    const { factoryId, launcher, tick } = await setUp({
      mode: 'automatic',
      maxConcurrent: 1,
      script: { labelled },
    });

    await tick();

    expect(launcher.issues()).toEqual([7]);
    const queue = (await createFactoryRunsRepository().queue(factoryId))._unsafeUnwrap();
    expect(queue.map((run) => [run.issueNumber, run.source])).toEqual([
      [8, 'label'],
      [9, 'label'],
    ]);
  });

  test('a labelled issue leaves the queue when it loses its label, or the factory turns manual', async () => {
    const script: Script = {
      labelled: [7, 8, 9].map((number) => ({ number, title: `L${number}`, url: `u/${number}` })),
    };
    const { factoryId, tick } = await setUp({ mode: 'automatic', maxConcurrent: 1, script });
    await tick();

    script.labelled = script.labelled!.filter((issue) => issue.number !== 8);
    await tick();
    expect((await runFor(factoryId, 8)).state).toBe('stopped');
    expect((await runFor(factoryId, 9)).state).toBe('requested');

    (
      await createFactorySettingsService().save('alice', 'p1', { enabled: true, mode: 'manual' })
    )._unsafeUnwrap();
    await tick();
    expect((await runFor(factoryId, 9)).state).toBe('stopped');
  });

  test('clearing the queue takes the label off its labelled issues, so they do not come back', async () => {
    const script: Script = {
      labelled: [7, 8].map((number) => ({ number, title: `L${number}`, url: `u/${number}` })),
    };
    const { factoryId, queue, github, tick } = await setUp({
      mode: 'automatic',
      maxConcurrent: 1,
      script,
    });
    await queue.submit(factoryId, { issueNumbers: [20], flowName: 'issue-to-merge' });
    await tick();

    const cleared = (await queue.clearQueue(factoryId))._unsafeUnwrap();

    expect(cleared.cleared).toBe(2);
    // Only the labelled ones lose a label; #20 was sent from funny.
    expect(github.unlabelled.sort()).toEqual([7, 8]);
  });

  test('a sent issue runs the flow it was sent with, not the factory flow', async () => {
    const { factoryId, queue, github, tick } = await setUp({
      flowName: 'issue-to-merge',
      waitThread: finishedThreads('completed'),
    });
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-pr' });

    await tick();

    // issue-to-pr stops at the pull request; issue-to-merge would have merged it.
    const run = await eventually(factoryId, 7, (r) => r.state === 'waiting_human');
    expect(run.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(github.merges).toBe(0);
  });

  test('a sent issue whose agent could not start goes back in line instead of being lost', async () => {
    const launcher = fakeLauncher('offline');
    const { factoryId, queue, tick } = await setUp({ launcher });
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    await tick();

    // The implementing agent was tried once (and its triage before it).
    const implementing = launcher.calls.filter((call) =>
      String(call.body.title).startsWith('[Factory] '),
    );
    expect(implementing).toHaveLength(1);
    const run = await eventually(factoryId, 7, (r) => r.state === 'requested');
    expect(run.source).toBe('manual');
    // A triage that never ran is not remembered: the next attempt triages again.
    expect(run.triage).toBeNull();
  });

  test('a queued issue closed since it was sent is dropped from the queue', async () => {
    const script: Script = {};
    const { factoryId, queue, launcher, tick } = await setUp({ script });
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });
    // GitHub now reports it closed (the fake reads the script on each call).
    script.closed = [7];

    await tick();

    expect(launcher.calls).toHaveLength(0);
    expect((await runFor(factoryId, 7)).state).toBe('stopped');
  });

  test('a queued issue closed while still blocked also leaves the queue', async () => {
    const script: Script = { blockers: { 7: [blocker(1)] } };
    const { factoryId, queue, tick } = await setUp({ script });
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });
    script.closed = [7];

    await tick();

    expect((await runFor(factoryId, 7)).state).toBe('stopped');
  });

  test('a finished sent issue is not admitted again', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      waitThread: finishedThreads('failed'),
    });
    await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });
    await tick();
    await eventually(factoryId, 7, (r) => r.state === 'failed');

    await tick();
    await tick();

    expect(launcher.calls).toHaveLength(1);
  });
});

describe('pause, clear and stop all', () => {
  test('pausing keeps the waiting issues; resuming admits them in order', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({ maxConcurrent: 5 });
    await queue.submit(factoryId, { issueNumbers: [1, 2], flowName: 'issue-to-merge' });
    await createFactorySettingsService().save('alice', 'p1', { enabled: false });

    await tick();
    expect(launcher.calls).toHaveLength(0);
    expect((await runsOf(factoryId)).every((r) => r.state === 'requested')).toBe(true);

    const resumed = await createFactorySettingsService().save('alice', 'p1', { enabled: true });
    expect(resumed._unsafeUnwrap().mode).toBe('manual');
    await tick();
    expect(launcher.issues()).toEqual([1, 2]);
  });

  test('clear queue removes the waiting issues and keeps the running one', async () => {
    const { factoryId, queue, tick } = await setUp({ maxConcurrent: 1 });
    await queue.submit(factoryId, { issueNumbers: [1], flowName: 'issue-to-merge' });
    await tick();
    await queue.submit(factoryId, { issueNumbers: [2, 3], flowName: 'issue-to-merge' });

    const cleared = (await queue.clearQueue(factoryId))._unsafeUnwrap();

    expect(cleared).toEqual({ cleared: 2, stopped: 0 });
    expect((await runFor(factoryId, 1)).state).toBe('working');
    expect((await runFor(factoryId, 2)).state).toBe('stopped');
    expect((await runFor(factoryId, 3)).state).toBe('stopped');
  });

  test('stop all clears the queue and stops the running runs', async () => {
    const { factoryId, queue, tick } = await setUp({ maxConcurrent: 1 });
    await queue.submit(factoryId, { issueNumbers: [1], flowName: 'issue-to-merge' });
    await tick();
    await queue.submit(factoryId, { issueNumbers: [2], flowName: 'issue-to-merge' });

    const stopped = (await queue.stopAll('alice', factoryId))._unsafeUnwrap();

    expect(stopped).toEqual({ cleared: 1, stopped: 1 });
    expect((await runsOf(factoryId)).map((r) => r.state)).toEqual(['stopped', 'stopped']);
  });

  test('stop all fails when a run in progress could not be stopped', async () => {
    const { factoryId, queue, tick } = await setUp({ maxConcurrent: 1 });
    await queue.submit(factoryId, { issueNumbers: [1], flowName: 'issue-to-merge' });
    await tick();
    const failing = createFactoryQueue({
      wake: async () => {},
      control: {
        stop: () => errAsync({ kind: 'storage' as const, message: 'database is locked' }),
        retry: () => errAsync({ kind: 'storage' as const, message: 'unused' }),
      },
    });

    const stopped = await failing.stopAll('alice', factoryId);

    expect(stopped._unsafeUnwrapErr()).toMatchObject({ kind: 'storage' });
  });

  test('cancelling one waiting issue keeps the order of the others', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({ maxConcurrent: 5 });
    await queue.submit(factoryId, { issueNumbers: [1, 2, 3], flowName: 'issue-to-merge' });
    const two = await runFor(factoryId, 2);

    expect((await createFactoryRunsRepository().cancel(factoryId, two.id))._unsafeUnwrap()).toEqual(
      [two.id],
    );
    await tick();

    expect(launcher.issues()).toEqual([1, 3]);
  });

  test('a run already admitted cannot be cancelled as waiting', async () => {
    const { factoryId, queue, tick } = await setUp();
    await queue.submit(factoryId, { issueNumbers: [1], flowName: 'issue-to-merge' });
    await tick();
    const run = await runFor(factoryId, 1);

    expect((await createFactoryRunsRepository().cancel(factoryId, run.id))._unsafeUnwrap()).toEqual(
      [],
    );
    expect((await runFor(factoryId, 1)).state).toBe('working');
  });
});

describe('blocked issues', () => {
  test('a sent issue whose flow has no proof rules stays queued, and says why', async () => {
    const builtIn = readFileSync(
      new URL('../../../../../workflows/defaults/issue-to-merge.yaml', import.meta.url),
      'utf8',
    );
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { repoFiles: { '.funny/workflows/issue-to-merge.yaml': builtIn } },
    });
    await queue.submit(factoryId, { issueNumbers: [1], flowName: 'issue-to-merge' });

    await tick();
    expect(launcher.issues()).toEqual([]);
    const run = await runFor(factoryId, 1);
    expect(run.state).toBe('requested');
    expect(run.waitReason).toEqual({ kind: 'proof-not-configured', blockers: [] });
  });

  test('a blocked issue waits and does not hold up the next one', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      maxConcurrent: 1,
      script: { blockers: { 2: [blocker(1)] } },
    });
    await queue.submit(factoryId, { issueNumbers: [2], flowName: 'issue-to-merge' });
    await queue.submit(factoryId, { issueNumbers: [5], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.issues()).toEqual([5]);
    expect((await runFor(factoryId, 2)).waitReason).toEqual({
      kind: 'blocker-not-sent',
      blockers: [1],
    });
  });

  test('an issue sent with its blocker waits until the blocker merges', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      maxConcurrent: 2,
      waitThread: finishedThreads('completed'),
      script: { blockers: { 2: [blocker(1)] } },
    });
    await queue.submit(factoryId, { issueNumbers: [1, 2], flowName: 'issue-to-merge' });

    await tick();
    expect(launcher.issues()).toEqual([1]);
    expect((await runFor(factoryId, 2)).waitReason?.kind).toBe('blocker-in-progress');

    // The blocker's run merges; GitHub still says the issue is open (no `Closes #1`).
    await eventually(factoryId, 1, (r) => r.state === 'merged');
    await tick();
    expect(launcher.issues()).toEqual([1, 2]);
  });

  test('a closed blocker does not hold the issue', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { blockers: { 2: [blocker(1, false)] } },
    });
    await queue.submit(factoryId, { issueNumbers: [2], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.issues()).toEqual([2]);
  });

  test('two issues blocked by each other show a circular dependency', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { blockers: { 1: [blocker(2)], 2: [blocker(1)] } },
    });
    await queue.submit(factoryId, { issueNumbers: [1, 2], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.calls).toHaveLength(0);
    expect((await runFor(factoryId, 1)).waitReason?.kind).toBe('circular');
    expect((await runFor(factoryId, 2)).waitReason?.kind).toBe('circular');
  });

  test('unreadable blockers hold the issue for that pass', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { blockers: { 2: 'unreadable' } },
    });
    await queue.submit(factoryId, { issueNumbers: [2], flowName: 'issue-to-merge' });

    await tick();

    expect(launcher.calls).toHaveLength(0);
    expect((await runFor(factoryId, 2)).waitReason?.kind).toBe('blockers-unreadable');
  });

  test('a labelled issue blocked by an open issue waits in automatic mode', async () => {
    const { factoryId, launcher, tick } = await setUp({
      mode: 'automatic',
      script: {
        labelled: [
          { number: 2, title: 'Blocked', url: 'u/2' },
          { number: 3, title: 'Free', url: 'u/3' },
        ],
        blockers: { 2: [blocker(1)] },
      },
    });

    await tick();

    expect(launcher.issues()).toEqual([3]);
    // It waits in the queue, saying what blocks it.
    const blocked = await runFor(factoryId, 2);
    expect(blocked).toMatchObject({ state: 'requested', source: 'label' });
    expect(blocked.waitReason?.kind).toStartWith('blocker-');
  });

  test('the send bar learns which open blockers are outside the factory', async () => {
    const { factoryId, queue } = await setUp({
      script: { blockers: { 2: [blocker(1), blocker(4, false), blocker(9, true, 'other/lib')] } },
    });
    await queue.submit(factoryId, { issueNumbers: [3], flowName: 'issue-to-merge' });

    const answer = (await queue.blockers(factoryId, [2]))._unsafeUnwrap();

    expect(answer).toEqual([{ issue: 2, blockers: [{ issue: 1, inFactory: false }] }]);
  });
});

/** A flow that needs no issue: one agent step and a notice, with one typed input. */
const AUDIT_FLOW = `name: audit
description: Look at an area and report
inputs:
  scope: { type: string, required: true }
nodes:
  - id: look
    spawn_agent:
      prompt: 'Audit {{scope}} and report.'
  - id: tell
    depends_on: [look]
    notify:
      message: 'Audit of {{scope}} finished'
`;

const auditFiles = () => ({ '.funny/workflows/audit.yaml': AUDIT_FLOW });

/** A clock the test moves. */
function clock(start: string) {
  let at = new Date(start);
  return {
    now: () => at,
    set: (iso: string) => {
      at = new Date(iso);
    },
  };
}

/** The factory's runs without an issue, oldest first. */
const issuelessRuns = async (factoryId: string) =>
  (await runsOf(factoryId)).filter((run) => run.issueNumber === null).reverse();

async function settled(
  factoryId: string,
  done: (runs: FactoryRunView[]) => boolean,
): Promise<FactoryRunView[]> {
  for (let i = 0; i < 200; i++) {
    const runs = await issuelessRuns(factoryId);
    if (done(runs)) return runs;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the runs never reached the expected state');
}

describe('starting a flow without an issue (change flow-triggers)', () => {
  test('a member starts a flow with typed inputs; it runs and ends done', async () => {
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { repoFiles: auditFiles() },
      waitThread: finishedThreads('completed'),
    });

    const started = await queue.runFlow(factoryId, {
      flowName: 'audit',
      inputs: { scope: 'auth' },
    });

    const run = started._unsafeUnwrap();
    expect(run).toMatchObject({
      issueNumber: null,
      source: 'run_now',
      state: 'requested',
      flowName: 'audit',
      inputs: { scope: 'auth' },
      triggerId: null,
    });

    await tick();
    const [ended] = await settled(factoryId, (runs) => runs[0]?.state === 'done');

    expect(ended!.completedAt).not.toBeNull();
    expect(launcher.calls).toHaveLength(1);
    const body = launcher.calls[0]!.body;
    expect(String(body.title)).toBe(`[Factory] run-${run.id.slice(0, 8)} audit`);
    expect(String(body.prompt)).toContain('Audit auth and report.');
    expect(JSON.stringify(body)).toContain(`factory/run-${run.id.slice(0, 8)}`);
  });

  test('a flow with a step that needs an issue is refused, naming the step', async () => {
    const { factoryId, queue } = await setUp();

    const started = await queue.runFlow(factoryId, { flowName: 'issue-to-merge', inputs: {} });

    const error = started._unsafeUnwrapErr();
    expect(error.kind).toBe('invalid-flow');
    expect(error.message).toContain('merge');
    expect(await issuelessRuns(factoryId)).toHaveLength(0);
  });

  test('a required input left empty is refused, naming the input', async () => {
    const { factoryId, queue } = await setUp({ script: { repoFiles: auditFiles() } });

    const empties: Array<Record<string, string>> = [{}, { scope: '  ' }];
    for (const inputs of empties) {
      const started = await queue.runFlow(factoryId, { flowName: 'audit', inputs });
      expect(started._unsafeUnwrapErr()).toMatchObject({ kind: 'invalid-flow' });
      expect(started._unsafeUnwrapErr().message).toContain('"scope"');
    }
    expect(await issuelessRuns(factoryId)).toHaveLength(0);
  });

  test('an input the factory supplies, or named like a credential, is refused', async () => {
    const { factoryId, queue } = await setUp({ script: { repoFiles: auditFiles() } });

    for (const name of ['repo', 'gh_token']) {
      const started = await queue.runFlow(factoryId, {
        flowName: 'audit',
        inputs: { scope: 'auth', [name]: 'x' },
      });
      expect(started._unsafeUnwrapErr()).toMatchObject({ kind: 'invalid' });
    }
  });

  test('a paused factory refuses the start as it refuses a sent issue', async () => {
    const { factoryId, queue } = await setUp({
      enabled: false,
      script: { repoFiles: auditFiles() },
    });

    const started = await queue.runFlow(factoryId, { flowName: 'audit', inputs: { scope: 'a' } });
    const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName: 'issue-to-merge' });

    expect(started._unsafeUnwrapErr()).toEqual(sent._unsafeUnwrapErr());
    expect(started._unsafeUnwrapErr().kind).toBe('paused');
  });

  test("the dialog learns a flow's inputs and why an issue flow cannot run", async () => {
    const { factoryId, queue } = await setUp({ script: { repoFiles: auditFiles() } });

    const audit = (await queue.issuelessFlow(factoryId, 'audit'))._unsafeUnwrap();
    const merge = (await queue.issuelessFlow(factoryId, 'issue-to-merge'))._unsafeUnwrap();

    expect(audit).toEqual({
      inputs: [{ name: 'scope', required: true, description: null }],
      problems: [],
    });
    expect(merge.problems.map((problem) => problem.field)).toEqual(
      expect.arrayContaining(['triage', 'review', 'merge']),
    );
  });

  test('a run whose flow gained a required input fails before any thread starts', async () => {
    const files = auditFiles();
    const { factoryId, queue, launcher, tick } = await setUp({ script: { repoFiles: files } });
    await queue.runFlow(factoryId, { flowName: 'audit', inputs: { scope: 'auth' } });
    files['.funny/workflows/audit.yaml'] = AUDIT_FLOW.replace(
      '  scope:',
      '  depth: { type: string, required: true }\n  scope:',
    );

    await tick();
    const [run] = await settled(factoryId, (runs) => runs[0]?.state === 'failed');

    expect(run!.failureReason).toContain('"depth"');
    expect(launcher.calls).toHaveLength(0);
  });
});

describe('schedule triggers (change flow-triggers)', () => {
  const everyFive = { name: 'Nightly audit', schedule: '*/5 * * * *', flowName: 'audit' };

  test('a saved trigger knows its next occurrence; an invalid schedule is refused', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue } = await setUp({
      script: { repoFiles: auditFiles() },
      now: time.now,
    });

    const saved = await queue.saveTrigger(factoryId, {
      ...everyFive,
      inputs: { scope: 'auth' },
      enabled: true,
    });
    const refused = await queue.saveTrigger(factoryId, {
      ...everyFive,
      schedule: 'every night',
      inputs: { scope: 'auth' },
      enabled: true,
    });

    expect(saved._unsafeUnwrap()).toMatchObject({
      name: 'Nightly audit',
      enabled: true,
      nextRunAt: '2026-11-23T02:05:00.000Z',
      inputs: { scope: 'auth' },
    });
    expect(refused._unsafeUnwrapErr().kind).toBe('invalid');
    expect((await queue.triggers(factoryId))._unsafeUnwrap()).toHaveLength(1);
  });

  test('a trigger for a flow that needs an issue, or misses an input, is refused', async () => {
    const { factoryId, queue } = await setUp({ script: { repoFiles: auditFiles() } });

    const issueFlow = await queue.saveTrigger(factoryId, {
      ...everyFive,
      flowName: 'issue-to-merge',
      inputs: {},
      enabled: true,
    });
    const noInput = await queue.saveTrigger(factoryId, { ...everyFive, inputs: {}, enabled: true });

    expect(issueFlow._unsafeUnwrapErr().kind).toBe('invalid-flow');
    expect(noInput._unsafeUnwrapErr().message).toContain('"scope"');
    expect((await queue.triggers(factoryId))._unsafeUnwrap()).toHaveLength(0);
  });

  test("an occurrence starts one run with the trigger's inputs and moves to the next", async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue, launcher, tick } = await setUp({
      script: { repoFiles: auditFiles() },
      waitThread: finishedThreads('completed'),
      now: time.now,
    });
    const trigger = (
      await queue.saveTrigger(factoryId, { ...everyFive, inputs: { scope: 'auth' }, enabled: true })
    )._unsafeUnwrap();

    await tick();
    expect(await issuelessRuns(factoryId)).toHaveLength(0);

    time.set('2026-11-23T02:05:20.000Z');
    await tick();
    const [run] = await settled(factoryId, (runs) => runs[0]?.state === 'done');

    expect(run).toMatchObject({
      source: 'schedule',
      triggerId: trigger.id,
      triggerName: 'Nightly audit',
      inputs: { scope: 'auth' },
      issueNumber: null,
    });
    expect(launcher.calls).toHaveLength(1);
    expect((await queue.triggers(factoryId))._unsafeUnwrap()[0]!.nextRunAt).toBe(
      '2026-11-23T02:10:00.000Z',
    );

    // The same tick again starts nothing: the occurrence was taken.
    await tick();
    expect(await issuelessRuns(factoryId)).toHaveLength(1);
  });

  test('an occurrence is skipped, and recorded, while the previous run still works', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue, tick, activities } = await setUp({
      script: { repoFiles: auditFiles() },
      now: time.now,
    });
    await queue.saveTrigger(factoryId, { ...everyFive, inputs: { scope: 'auth' }, enabled: true });

    time.set('2026-11-23T02:05:20.000Z');
    await tick();
    await settled(factoryId, (runs) => runs[0]?.state === 'working');
    time.set('2026-11-23T02:10:20.000Z');
    await tick();

    expect(await issuelessRuns(factoryId)).toHaveLength(1);
    expect(activities).toEqual(['factory.trigger_skipped']);
  });

  test('an occurrence missed by more than five minutes is not run late', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue, tick } = await setUp({
      script: { repoFiles: auditFiles() },
      now: time.now,
    });
    await queue.saveTrigger(factoryId, { ...everyFive, inputs: { scope: 'auth' }, enabled: true });

    time.set('2026-11-23T03:02:00.000Z');
    await tick();

    expect(await issuelessRuns(factoryId)).toHaveLength(0);
    expect((await queue.triggers(factoryId))._unsafeUnwrap()[0]!.nextRunAt).toBe(
      '2026-11-23T03:05:00.000Z',
    );
  });

  test('a run parked on its pull request does not hold its trigger', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const flow = `name: bump
nodes:
  - id: work
    spawn_agent:
      prompt: 'Update the dependencies.'
  - id: pull-request
    depends_on: [work]
    create_pr:
      title: 'Update dependencies'
      body: 'Scheduled update.'
      base: main
`;
    const { factoryId, queue, tick, github } = await setUp({
      script: { repoFiles: { '.funny/workflows/bump.yaml': flow } },
      waitThread: finishedThreads('completed'),
      now: time.now,
    });
    await queue.saveTrigger(factoryId, {
      name: 'Weekly bump',
      schedule: '*/5 * * * *',
      flowName: 'bump',
      inputs: {},
      enabled: true,
    });

    time.set('2026-11-23T02:05:20.000Z');
    await tick();
    const [first] = await settled(factoryId, (runs) => runs[0]?.state === 'waiting_human');
    expect(first!.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(github.merges).toBe(0);

    time.set('2026-11-23T02:10:20.000Z');
    await tick();
    await settled(factoryId, (runs) => runs.length === 2);
  });

  test('a disabled trigger has no next occurrence and starts nothing', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue, tick } = await setUp({
      script: { repoFiles: auditFiles() },
      now: time.now,
    });
    const saved = await queue.saveTrigger(factoryId, {
      ...everyFive,
      inputs: { scope: 'auth' },
      enabled: false,
    });

    time.set('2026-11-23T02:05:20.000Z');
    await tick();

    expect(saved._unsafeUnwrap().nextRunAt).toBeNull();
    expect(await issuelessRuns(factoryId)).toHaveLength(0);
  });

  test('editing a trigger does not change the inputs of a run in progress', async () => {
    const time = clock('2026-11-23T02:01:00.000Z');
    const { factoryId, queue, tick } = await setUp({
      script: { repoFiles: auditFiles() },
      now: time.now,
    });
    const trigger = (
      await queue.saveTrigger(factoryId, { ...everyFive, inputs: { scope: 'auth' }, enabled: true })
    )._unsafeUnwrap();
    time.set('2026-11-23T02:05:20.000Z');
    await tick();
    await settled(factoryId, (runs) => runs[0]?.state === 'working');

    await queue.saveTrigger(factoryId, {
      ...everyFive,
      id: trigger.id,
      name: 'Renamed',
      inputs: { scope: 'billing' },
      enabled: true,
    });

    const [run] = await issuelessRuns(factoryId);
    expect(run).toMatchObject({ triggerName: 'Nightly audit', inputs: { scope: 'auth' } });
  });

  test("a trigger is removed; another factory's trigger is not found", async () => {
    const { factoryId, queue } = await setUp({ script: { repoFiles: auditFiles() } });
    const trigger = (
      await queue.saveTrigger(factoryId, { ...everyFive, inputs: { scope: 'auth' }, enabled: true })
    )._unsafeUnwrap();

    expect((await queue.removeTrigger('another-factory', trigger.id))._unsafeUnwrapErr().kind).toBe(
      'not-found',
    );
    expect((await queue.removeTrigger(factoryId, trigger.id)).isOk()).toBe(true);
    expect((await queue.triggers(factoryId))._unsafeUnwrap()).toHaveLength(0);
  });
});
