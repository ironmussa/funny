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
import { createFactoryQueue } from '../../../services/factory/factory-queue.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import {
  type CreatePoll,
  startFactoryWatcher,
  stopFactoryWatcher,
} from '../../../services/factory/factory-watcher.js';
import type { StartThreadInput } from '../../../services/runner-thread-launcher.js';
import {
  launchedThread,
  passingProof,
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
}

/** The fake GitHub port, with the merges the test reads back. */
type FakeGithub = FactoryGithubPort & { merges: number };

function fakeGithub(script: Script = {}): FakeGithub {
  const port: FakeGithub = {
    merges: 0,
    resolveRepo: async () => (script.noRepo ? null : 'o/r'),
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
    branchAhead: () => okAsync(true),
    defaultBranch: () => okAsync('main'),
    branchState: () => okAsync({ sha: 'base-sha', ci: { kind: 'green' as const } }),
    revertPullRequest: () => okAsync({ url: 'https://github.com/o/r/pull/99', number: 99 }),
    relabelIssue: () => okAsync(undefined),
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
    script?: Script;
    launcher?: ReturnType<typeof fakeLauncher>;
    waitThread?: (id: string, signal: AbortSignal) => Promise<any>;
  } = {},
) {
  const settings = createFactorySettingsService();
  const saved = await settings.save('alice', 'p1', {
    enabled: opts.enabled ?? true,
    mode: opts.mode,
    maxConcurrent: opts.maxConcurrent,
    flowName: opts.flowName,
  });
  if (saved.isErr()) throw new Error(saved.error.message);
  const factoryId = (await settings.factoryId('alice', 'p1'))._unsafeUnwrap()!;
  const poll = fakePoll();
  const launcher = opts.launcher ?? fakeLauncher();
  const github = fakeGithub(opts.script);
  await startFactoryWatcher({
    ports: unusedRunnerPorts(),
    github,
    createPoll: poll.createPoll,
    launch: launcher.launch,
    resolveRuntime: async () => 'local' as const,
    waitThread: opts.waitThread ?? pendingThreads,
    notify: async () => undefined,
    proof: passingProof,
    lastThreadMessage: passingReview,
  });
  // The tests fire the tick themselves: a send does not poke the factory here.
  const queue = createFactoryQueue({ wake: async () => {} });
  const tick = () => poll.ticks[0]!();
  return { factoryId, queue, launcher, github, tick };
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

  test('a workspace-only or unknown flow is refused', async () => {
    const { factoryId, queue } = await setUp();

    for (const flowName of ['factory-issue', 'no-such-flow']) {
      const sent = await queue.submit(factoryId, { issueNumbers: [7], flowName });
      expect(sent._unsafeUnwrapErr()).toMatchObject({ kind: 'invalid-flow' });
    }
    expect(await runsOf(factoryId)).toHaveLength(0);
  });

  test('the flows a send may pick: built-ins plus the repository flows, never factory-issue', async () => {
    const { factoryId, queue } = await setUp({
      script: { repoFlows: ['custom.yaml', 'factory-issue.yaml', 'issue-to-pr.yml', 'README.md'] },
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
    expect(await runFor(factoryId, 7)).toBeUndefined();
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
    expect(await runFor(factoryId, 2)).toBeUndefined();
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
