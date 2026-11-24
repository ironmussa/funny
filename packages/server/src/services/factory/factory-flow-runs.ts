/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Runs a factory run's flow on the server as the factory's enabler (change
 * factory-flow-execution, task 3.2): the compiled flow (`factory-flow.ts`)
 * through `@funny/pipelines` with the factory's server provider, its progress
 * written to `factory_runs` (`currentStep`, `threadIds`, the PR, the state).
 *
 * A run's flow lives in this process while its threads run. After a restart
 * (or a launch interrupted by one) the watcher starts it again, and no work is
 * started twice nor a finished thread waited on again: the engine's journal
 * (`workflow_node_executions`, change workflow-dag-engine) replays the steps
 * that finished and hands an unfinished one what it checkpointed. A run
 * without journal rows (from before the journal, or reopened by a retry or a
 * take-over) replays its recorded threads by call order instead, once.
 *
 * How a run ends:
 * - the flow completes → `waiting_human`, unless it merged (`merged`);
 * - the flow fails once its pull request is open (e.g. CI still red after
 *   the fixes the flow allows) → `waiting_human` at the failed step: the work
 *   is on GitHub for the member to take over or retry, and they are notified;
 * - the flow fails before that, after an agent ran → `failed` (an attempt: the
 *   watcher re-admits the issue up to `MAX_ATTEMPTS` times);
 * - the flow fails before any agent ran (e.g. the runner is offline) → a
 *   label run is dropped, not counted, and a later tick tries again; a sent
 *   issue goes back to the queue (`requested`) in its place, so the request
 *   is not lost;
 * - the run was stopped, or the watcher shut down → nothing more is written.
 */

import {
  nullReporter,
  runPipeline,
  type ConcurrencyGate,
  type MemoryGateOptions,
} from '@funny/pipelines';
import { errorMessage } from '@funny/shared/errors';
import type { NodeOutput, YamlPipelineContext } from '@funny/workflows/compiler';
import { and, asc, desc, eq, gte, like } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { messages, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import type {
  StartedThread,
  StartThreadError,
  StartThreadInput,
} from '../runner-thread-launcher.js';
import { sendPush } from '../web-push.js';
import {
  createWorkflowJournalRepository,
  databaseJournal,
  type JournalCodec,
} from '../workflow-engine/journal-repository.js';
import { createLeaseGate } from '../workflow-engine/lease-gate.js';
import {
  createFactoryActionProvider,
  type FactoryContinuation,
  type FactoryProofDeps,
  type FactoryRunScope,
  type FactoryThreadMode,
  NO_CHANGE_TRIAGE_LABEL,
} from './factory-action-provider.js';
import {
  createFactoryBatchesRepository,
  type FactoryBatchesRepository,
} from './factory-batches.js';
import type { EarlyIntegration, EarlyOutcome } from './factory-early-integration.js';
import {
  formatFactoryFlowProblems,
  validateFlowForIssuelessRun,
} from './factory-flow-validation.js';
import {
  isMergeLane,
  flowReadsOf,
  loadFactoryFlow,
  type FactoryFlowContext,
  type FactoryFlow,
  type FactoryFlowError,
} from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import type { QueueMember } from './factory-merge-queue.js';
import { prNumberOf } from './factory-pull-requests.js';
import { createFactoryQueuePort, type FactoryQueuePort } from './factory-queue-port.js';
import { readWorkflowFiles } from './factory-readiness.js';
import {
  factoryRunBranch,
  REOPENED_STEP,
  threadsOf,
  type createFactoryRunsRepository,
  type FactoryRunView,
  type UpdateRunInput,
} from './factory-runs.js';
import {
  getWatchedFactory,
  projectAgentDefaults,
  type WatchedFactory,
} from './factory-settings.js';
import type { BlockerState } from './factory-stacking.js';
import type { FactoryStepDeps } from './factory-step-runner.js';
import type { KeptWorktree } from './factory-thread-requests.js';
import {
  createThreadWaits,
  lastThreadMessage,
  type ThreadOutcome,
  type WaitAfter,
} from './factory-thread-waits.js';
import { busyPathsOf, type FactorySplitDeps } from './factory-triage.js';

export interface FactoryRunJob {
  factory: WatchedFactory;
  repo: string;
  mode: FactoryThreadMode;
  /** The run's issue as GitHub has it; null for a run without one (change flow-triggers). */
  issue: FactoryIssue | null;
  run: FactoryRunView;
}

export interface FactoryFlowRunsDeps {
  runs: ReturnType<typeof createFactoryRunsRepository>;
  github: FactoryGithubPort;
  launch(input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>>;
  waitThread?: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /** A thread's last assistant message (tests); defaults to the stored one. */
  lastThreadMessage?: (threadId: string) => Promise<string | null>;
  /**
   * Send a follow-up to the enabler's thread, so later agent steps continue
   * the first one; without it each agent step starts a new thread.
   */
  followUp?: (
    userId: string,
    threadId: string,
    content: string,
    expectedBranch?: string,
    /** The step's agent options, carried on the message body. */
    options?: Record<string, unknown>,
  ) => Promise<Result<void, string>>;
  /** The merge queue's batches (tests); default: the database's. */
  batches?: FactoryBatchesRepository;
  /** Record why the factory cannot make progress (a run that could not start). */
  reportBlocked?: (factoryId: string, reason: string) => Promise<void>;
  /** Stop the enabler's threads (one a launch started after its run was stopped). */
  stopThreads?: (userId: string, threadIds: string[]) => Promise<void>;
  /** Remove the worktree and local branch of a merged run's threads (best effort). */
  cleanupMerged?: (userId: string, threadIds: string[]) => Promise<void>;
  /**
   * The same for a run that ended without a pull request, keeping (and
   * returning) the worktrees with uncommitted files or unpushed commits.
   */
  cleanupUnchanged?: (userId: string, threadIds: string[]) => Promise<KeptWorktree[]>;
  loadFlow?: (
    job: FactoryRunJob,
    context: FactoryFlowContext,
  ) => Promise<Result<FactoryFlow, FactoryFlowError>>;
  /** Regression proof start/poll through the enabler's runner. */
  proof?: (userId: string, threadId: string) => FactoryProofDeps;
  /** Factory steps (a flow's command, integrate) through the enabler's runner. */
  steps?: (userId: string) => FactoryStepDeps;
  /** Tell the enabler a run waits for them; defaults to Web Push. */
  notify?: (userId: string, message: WaitingNotice) => Promise<NotifyOutcome>;
  /**
   * Grants the flows' concurrency-group slots. Default: database leases shared
   * by every server instance (`createLeaseGate`), stopped by `stopAll`, so
   * `merge-{{inputs.repo}}` with limit 1 merges one pull request at a time
   * per repository however many servers run.
   */
  gate?: ConcurrencyGate;
}

/** What a notifier answers: how many devices Web Push reached, or nothing. Never read. */
export type NotifyOutcome = number | void;

export interface WaitingNotice {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** What the flow left behind when it ended, for `settle`. */
interface FlowTrace {
  agentsRan: boolean;
  prOpen: boolean;
  /** The last step the flow entered. */
  step: string | null;
  /** A step left the run for a person itself (e.g. `no change`): the end keeps that. */
  parked: boolean;
  /**
   * Triage took the run out of flight itself: it waits on its issue
   * (`needs_info`) or in the queue behind other work on the same files. The
   * end changes nothing about it.
   */
  held: boolean;
  /** A step ended the run itself (`no_change`): nothing is left to settle. */
  ended: boolean;
}

/** Note what a recorded update means for the flow's end; whether it recorded an agent thread. */
function traceRecorded(trace: FlowTrace, input: UpdateRunInput): boolean {
  if (input.prUrl) trace.prOpen = true;
  if (input.state === 'waiting_human') trace.parked = true;
  if (input.state === 'needs_info') trace.held = true;
  if (input.state === 'no_change' || input.state === 'done') trace.ended = true;
  if (!input.threadIds) return false;
  trace.agentsRan = true;
  return true;
}

function logFlowWarnings(job: FactoryRunJob, flow: FactoryFlow): void {
  for (const warning of flow.warnings) {
    log.warn('Issue factory flow has a warning', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: job.run.id,
      flow: flow.name,
      path: warning.path,
      warning: warning.message,
    });
  }
}

/** Allowance for the runner's clock being behind the server's when matching a launch. */
const LAUNCH_CLOCK_SLACK_MS = 60 * 1000;

const slackBefore = (since: string) =>
  new Date(Date.parse(since) - LAUNCH_CLOCK_SLACK_MS).toISOString();

async function threadCompletedAt(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ completedAt: threads.completedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.completedAt ?? null;
}

/** A user message on the thread since `since`: an interrupted follow-up reached it. */
async function followedUpSince(threadId: string, since: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        gte(messages.timestamp, slackBefore(since)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The factory thread an interrupted launch started: the enabler's, in the
 * project, with the step's title, created since the launch began. One run per
 * issue is in flight and its steps run one at a time, so the title and the time
 * identify it.
 */
async function findLaunchedThread(
  scope: { userId: string; projectId: string },
  titlePrefix: string,
  since: string,
  /** The newest match instead of the oldest (a review thread: an older one may be a stopped attempt). */
  newest = false,
): Promise<string | null> {
  const after = slackBefore(since);
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, scope.userId),
        eq(threads.projectId, scope.projectId),
        eq(threads.source, 'factory'),
        // The prefix (`[Factory] #N `) is stable; the issue title may have changed.
        like(threads.title, `${titlePrefix}%`),
        gte(threads.createdAt, after),
      ),
    )
    .orderBy(newest ? desc(threads.createdAt) : asc(threads.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Whether a started run has an agent working (or is done), or never started one. */
export type FactoryRunStart = 'started' | 'not-started';

/** How a run is named to a person: its issue, or its trigger (or flow) without one. */
const subjectOf = (job: FactoryRunJob): string =>
  job.issue ? `Issue #${job.issue.number}` : `"${job.run.triggerName ?? flowOf(job)}"`;

/**
 * The flow's inputs for a run: the issue's for an issue run, what its trigger
 * recorded otherwise, then the factory's own, which always win.
 */
export function flowInputsOf(
  job: Pick<FactoryRunJob, 'repo' | 'issue'> & {
    factory: Pick<WatchedFactory, 'id'>;
    run: Pick<FactoryRunView, 'inputs'>;
  },
  // What the host's concurrency groups are named by (the merge lane, stage limits),
  // and a stacked run's blocker branch (empty otherwise).
  at: { branch: string; baseBranch: string; stackBranch?: string },
): Record<string, string> {
  const subject = job.issue
    ? {
        issue_number: String(job.issue.number),
        issue_title: job.issue.title,
        issue_url: job.issue.url,
      }
    : job.run.inputs;
  return {
    ...subject,
    repo: job.repo,
    branch: at.branch,
    base_branch: at.baseBranch,
    factory_id: job.factory.id,
    stack_branch: at.stackBranch ?? '',
  };
}

/** A run a retry or take-over put back in flight (it has a history). */
const wasReopened = (job: FactoryRunJob) => job.run.currentStep === REOPENED_STEP;

/** What the thread view says about a failed run: the flow's error. */
const failureReason = (error: string | undefined): string => error?.trim() || 'The flow failed.';

/**
 * The flow the run executes: the one it recorded (chosen when the issue was
 * sent, or the factory's at admission), else the factory's for rows from
 * before runs recorded their own.
 */
const flowOf = (job: FactoryRunJob): string => job.run.flowName ?? job.factory.flowName;

/**
 * The step outputs a journal stored: an object per step. JSON drops an
 * undefined `output`, so a missing one reads back as undefined.
 */
const STORED_OUTPUTS = z.record(
  z.string(),
  z
    .looseObject({ output: z.unknown().optional() })
    .transform((stored): NodeOutput => ({ ...stored, output: stored.output })),
);

/**
 * The journal keeps the flow's step outputs; the rest of the context (the
 * provider, the progress reporter, the inputs) is this attempt's, rebuilt by
 * the server that resumes the run.
 */
const journalCodec = (
  live: YamlPipelineContext,
): JournalCodec<YamlPipelineContext, Record<string, NodeOutput>> => ({
  encode: (ctx) => ctx.outputs,
  decode: (stored) => ({ ...live, outputs: STORED_OUTPUTS.parse(stored) }),
});

/** The given gate, or this server's lease gate with how to stop renewing its leases. */
function flowGate(
  given: ConcurrencyGate | undefined,
  rules: Pick<MemoryGateOptions, 'resolveLimit' | 'priority'>,
): { gate: ConcurrencyGate; stop: () => void } {
  if (given) return { gate: given, stop: () => {} };
  const leases = createLeaseGate(rules);
  return { gate: leases, stop: () => leases.stop() };
}

/** How many runs of a factory may be inside a stage at once, unless the flow or the factory says. */
const DEFAULT_STAGE_LIMIT = 20;

/** The concurrency group of a stage of one factory (`<node>:<factoryId>`). */
const stageGroup = (stage: string, factoryId: string) => `${stage}:${factoryId}`;

/** Admission times are ordered as whole seconds from here (they fit a 32-bit column). */
const PRIORITY_EPOCH_MS = Date.parse('2025-01-01T00:00:00.000Z');

/**
 * A run's place among the waiters of a group: the earlier it was admitted, the
 * sooner it gets the slot. A run blocked by another issue is admitted only
 * after its blocker finished, so admission order puts it behind.
 */
export function admissionPriority(run: Pick<FactoryRunView, 'admittedAt' | 'startedAt'>): number {
  const admitted = Date.parse(run.admittedAt ?? run.startedAt);
  if (!Number.isFinite(admitted)) return 0;
  return Math.max(0, Math.floor((admitted - PRIORITY_EPOCH_MS) / 1000));
}

/** A blocker that ended in one of these will not merge: the runs stacked on it park (D10). */
const GONE_STATES: ReadonlySet<string> = new Set(['failed', 'stopped', 'no_change']);

/**
 * Per factory, one triage contract-and-paths check at a time (in this process,
 * like the watcher), as slot writes are serialized in `factory-runs.ts`: two
 * runs triaged together would otherwise each miss the other's paths.
 */
const pathChecks = (() => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(factoryId: string, work: () => Promise<T>): Promise<T> {
      const result = (tails.get(factoryId) ?? Promise.resolve()).then(work);
      const tail = result.catch(() => undefined);
      tails.set(factoryId, tail);
      void tail.then(() => {
        if (tails.get(factoryId) === tail) tails.delete(factoryId);
      });
      return result;
    },
  };
})();

/** A bucket's weight in a merge priority: above any admission order (seconds since 2026). */
const MERGE_BUCKET = 10_000_000_000;

/**
 * A run's place among the waiters of the merge group (openspec
 * factory-integration D11): a blocker of other runs first; then by size in
 * powers of four of its changed lines, so a much smaller change does not wait
 * behind a large one; within a size, admission order.
 */
export function mergePriority(
  admission: number,
  opts: { blocker: boolean; lines?: number },
): number {
  if (opts.blocker) return admission;
  const bucket = opts.lines && opts.lines > 1 ? Math.floor(Math.log(opts.lines) / Math.log(4)) : 0;
  return (1 + bucket) * MERGE_BUCKET + admission;
}

export function createFactoryFlowRuns(deps: FactoryFlowRunsDeps) {
  const active = new Map<string, AbortController>();
  /** Each running flow's early integration (D8), for the watcher to ask when the base moves. */
  const earlyOf = new Map<string, EarlyIntegration>();
  const waitThread = deps.waitThread ?? createThreadWaits();
  const journalRows = createWorkflowJournalRepository();
  /** Each run's place in a group's queue, by its id (the holder is `<runId>/<node>/<visit>`). */
  const priorities = new Map<string, number>();
  /** What orders a run in the merge group: whether it blocks other runs, and its size. */
  const mergeOrder = new Map<string, { blocker: boolean; lines?: number }>();
  const priorityOf = (holder: string): number => {
    const [runId = '', node] = holder.split('/');
    const admission = priorities.get(runId) ?? 0;
    const order = mergeOrder.get(runId);
    return node === 'merge' && order ? mergePriority(admission, order) : admission;
  };
  /** Each factory's own stage limits, by its id: what replaces a flow's declared limit. */
  const stageLimits = new Map<string, Record<string, number>>();
  /** The factory's limit for a stage group (`<node>:<factoryId>`), when it set one. */
  const stageLimitOf = (group: string): number | undefined => {
    const at = group.lastIndexOf(':');
    return at < 0 ? undefined : stageLimits.get(group.slice(at + 1))?.[group.slice(0, at)];
  };
  const { gate, stop: stopGate } = flowGate(deps.gate, {
    // The merge lane is one at a time, whatever a flow or a setting says.
    resolveLimit: (group, declared) => (isMergeLane(group) ? 1 : (stageLimitOf(group) ?? declared)),
    priority: priorityOf,
  });

  const loadFlow =
    deps.loadFlow ??
    ((job: FactoryRunJob, context: FactoryFlowContext) =>
      loadFactoryFlow(
        flowOf(job),
        flowReadsOf(deps.github, {
          repo: job.repo,
          ownerId: job.factory.userId,
          projectId: job.factory.projectId,
        }),
        context,
      ));

  /** A run whose flow could not be loaded: dropped when it never ran, failed when invalid. */
  async function flowUnavailable(job: FactoryRunJob, error: FactoryFlowError): Promise<void> {
    log.warn('Issue factory flow could not be loaded', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: job.run.id,
      flow: flowOf(job),
      kind: error.kind,
      error: error.message,
    });
    await deps.reportBlocked?.(
      job.factory.id,
      `The flow "${flowOf(job)}" could not be loaded: ${error.message}`,
    );
    if (error.kind === 'invalid') {
      await deps.runs.updateInFlight(job.run.id, {
        state: 'failed',
        currentStep: null,
        failureReason: `The flow "${flowOf(job)}" could not be loaded: ${error.message}`,
      });
    } else if (job.run.threadIds.length === 0 && !wasReopened(job)) {
      // A run that never ran is dropped (a sent one goes back in line); a
      // retried one stays queued for a later tick.
      await forgetUnstarted(job);
    }
  }

  /** A run that never started an agent: a sent issue goes back in line, a label run is dropped. */
  async function forgetUnstarted(job: FactoryRunJob): Promise<void> {
    // What a person sent or started waits in line; a labelled issue is found
    // again, and a scheduled occurrence that could not start is not run late.
    if (job.run.source === 'manual' || job.run.source === 'run_now') {
      await deps.runs.requeue(job.run.id);
    } else await deps.runs.remove(job.run.id);
  }

  const notify = deps.notify ?? sendPush;

  /** Tell the enabler their run waits for them; best-effort. */
  async function noticeWaiting(job: FactoryRunJob, why: string): Promise<void> {
    await notify(job.factory.userId, {
      title: `${subjectOf(job)} needs you`,
      body: why.length > 200 ? `${why.slice(0, 199)}…` : why,
      url: `/projects/${job.factory.projectId}`,
      tag: `factory-run-${job.run.id}`,
    }).catch((cause: unknown) =>
      log.warn('Issue factory notification failed', {
        namespace: 'factory',
        runId: job.run.id,
        error: errorMessage(cause),
      }),
    );
  }

  /**
   * Leave the run for the member — completed without a merge, or failed (at
   * `failedStep`) with its pull request open — and tell them.
   */
  async function park(job: FactoryRunJob, failedStep: string | null, error?: string) {
    const parked = await deps.runs.updateInFlight(job.run.id, {
      state: 'waiting_human',
      currentStep: failedStep,
      failureReason: failedStep ? failureReason(error) : null,
    });
    if (parked.isErr() || !parked.value) return;
    const why = failedStep
      ? `The ${failedStep} step failed: ${error ?? ''}`.trim()
      : 'Its pull request is ready.';
    await noticeWaiting(job, why);
  }

  /** A run whose agent never started (e.g. the runner is offline): not an attempt, but say why. */
  async function dropUnstarted(job: FactoryRunJob, error?: string): Promise<void> {
    await forgetUnstarted(job);
    await deps.reportBlocked?.(
      job.factory.id,
      `${subjectOf(job)} could not start: ${error ?? 'unknown error'}`,
    );
  }

  /** Record the flow's end in the run (see the module comment). */
  /** The run merged: clean its threads' worktrees up without holding the flow. */
  function cleanUpMerged(job: FactoryRunJob): void {
    if (!deps.cleanupMerged) return;
    const cleanup = deps.cleanupMerged;
    void deps.runs.get(job.run.id).match(
      (run) => cleanup(job.factory.userId, threadsOf(run ?? job.run)),
      () => cleanup(job.factory.userId, threadsOf(job.run)),
    );
  }

  /** A flow that failed: dropped before any agent ran, left as a step parked it, failed, or parked. */
  async function settleFailed(job: FactoryRunJob, trace: FlowTrace, error?: string): Promise<void> {
    const { run } = job;
    // Triage parked it on its issue or sent it back to the queue: nothing to settle.
    if (trace.held) return;
    // The step wrote the run's end: not a failure, and nobody is waited for.
    if (trace.ended) return;
    if (!trace.agentsRan && !wasReopened(job)) return dropUnstarted(job, error);
    if (trace.parked) {
      await deps.runs.updateInFlight(run.id, { currentStep: trace.step });
      await noticeWaiting(job, error ?? 'It waits for you.');
      return;
    }
    if (trace.prOpen) {
      await park(job, trace.step, error);
      return;
    }
    await deps.runs.updateInFlight(run.id, {
      state: 'failed',
      currentStep: trace.step,
      failureReason: failureReason(error),
    });
  }

  async function settle(
    job: FactoryRunJob,
    outcome: 'completed' | 'failed' | 'cancelled',
    trace: FlowTrace,
    error?: string,
  ): Promise<void> {
    const { run } = job;
    if (outcome === 'cancelled') return;
    if (outcome === 'failed') await settleFailed(job, trace, error);
    // A run without an issue that opened no pull request has nothing left to follow.
    else if (job.issue === null && !trace.prOpen) {
      await deps.runs.updateInFlight(run.id, { state: 'done', currentStep: null });
    } else await park(job, null, error);
    log.info('Issue factory run ended', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: run.id,
      issue: run.issueNumber,
      outcome: trace.ended ? 'no_change' : outcome,
      error,
    });
  }

  /** The default branch's GitHub Actions workflows, read as the leader's enabler; null if unreadable. */
  const readWorkflows = (leader: QueueMember) =>
    readWorkflowFiles(deps.github, {
      repo: leader.repo,
      ownerId: leader.userId,
      projectId: leader.projectId,
    });

  /** Where a stacked run's blocker stands (D10): merged, still worked on, or gone without merging. */
  async function blockerStateOf(stackedOn: FactoryRunView['stackedOn']): Promise<BlockerState> {
    if (!stackedOn) return 'merged';
    const blocker = (await deps.runs.get(stackedOn.runId)).unwrapOr(null);
    if (!blocker) return 'gone';
    if (blocker.state === 'merged') return 'merged';
    return GONE_STATES.has(blocker.state) ? 'gone' : 'in-flight';
  }

  /** Whether another queued run of the factory waits for this run's issue (it is a blocker). */
  async function blocksOthers(job: FactoryRunJob): Promise<boolean> {
    // A run without an issue blocks nobody: blockers are issues.
    const issue = job.run.issueNumber;
    if (issue === null) return false;
    const queued = await deps.runs.queue(job.factory.id);
    if (queued.isErr()) return false;
    return queued.value.some((run) => run.waitReason?.blockers.includes(issue));
  }

  /**
   * The merge queue for a run's `merge` step (openspec factory-integration
   * D2): absent where the GitHub side cannot build per-enabler providers.
   * A member that lands is recorded merged on its own run, and its threads'
   * worktrees are cleaned up as its own flow would.
   */
  function queueFor(signal: AbortSignal): FactoryQueuePort | undefined {
    const integrationFor = deps.github.pullRequests.integrationFor;
    if (!integrationFor) return undefined;
    const run = async (runId: string) => (await deps.runs.get(runId)).unwrapOr(null);
    return createFactoryQueuePort({
      batches: deps.batches ?? createFactoryBatchesRepository(),
      run,
      factory: getWatchedFactory,
      record: async (runId, input) => {
        const live = await deps.runs.updateInFlight(runId, input);
        if (!live.isOk() || !live.value || input.state !== 'merged' || !deps.cleanupMerged) return;
        const merged = await run(runId);
        const factory = merged ? await getWatchedFactory(merged.factoryId) : null;
        if (merged && factory) await deps.cleanupMerged(factory.userId, threadsOf(merged));
      },
      integrationFor: (owner) => integrationFor(owner),
      workflows: (leader) => readWorkflows(leader),
      signal,
    });
  }

  /** Following up on the run's threads, when this host can (`deps.followUp`). */
  function continuationFor(scope: FactoryRunScope): FactoryContinuation | undefined {
    const followUp = deps.followUp;
    if (!followUp) return undefined;
    return {
      // The run's branch: a worktree switched away refuses the step.
      followUp: (threadId, content, options) =>
        followUp(scope.userId, threadId, content, scope.branch, { ...options }),
      completedAt: threadCompletedAt,
      followedUpSince,
      // A reviewer's thread is on its own branch: no branch guard.
      followUpOffBranch: (threadId, content) => followUp(scope.userId, threadId, content),
    };
  }

  /** The regression proof on the enabler's runner, when this host runs one (`deps.proof`). */
  function proofFor(scope: FactoryRunScope): FactoryProofDeps | undefined {
    const proof = deps.proof;
    if (!proof) return undefined;
    return {
      startProof: (threadId, body) => proof(scope.userId, threadId).startProof(threadId, body),
      pollProof: (threadId, proofId) => proof(scope.userId, threadId).pollProof(threadId, proofId),
      cancelProof: async (threadId, proofId) =>
        proof(scope.userId, threadId).cancelProof?.(threadId, proofId),
    };
  }

  /** Point a run's pull request at `base` (a stacked run, once its blocker landed: D10). */
  async function retargetRun(
    job: FactoryRunJob,
    scope: FactoryRunScope,
    base: string,
  ): Promise<Result<void, string>> {
    // The pull request was opened during the flow: read where it is now.
    const live = (await deps.runs.get(job.run.id)).unwrapOr(null);
    const pr = prNumberOf(live?.prUrl ?? null);
    const retarget = deps.github.pullRequests.retarget;
    if (pr === null || !retarget) return err('the run has no pull request to retarget');
    const done = await retarget(
      { repo: scope.repo, number: pr, userId: scope.userId, projectId: scope.projectId },
      base,
    );
    return done.mapErr((e) => e.message);
  }

  /**
   * What a run's provider needs for openspec factory-integration: the merge
   * queue, stacking on a blocker (D10), early integration (D8) and the queue's
   * order by size (D11).
   */
  function integrationDepsFor(job: FactoryRunJob, scope: FactoryRunScope, signal: AbortSignal) {
    return {
      queue: queueFor(signal),
      stackedOn: job.run.stackedOn,
      blockerState: () => blockerStateOf(job.run.stackedOn),
      retarget: (base: string) => retargetRun(job, scope, base),
      registerEarly: (early: EarlyIntegration) => earlyOf.set(job.run.id, early),
      onChangeSize: (lines: number) => {
        const order = mergeOrder.get(job.run.id) ?? { blocker: false };
        mergeOrder.set(job.run.id, { ...order, lines });
      },
    };
  }

  /** What a run's steps are bound to; a run without an issue is titled by its trigger or flow. */
  const scopeOf = (job: FactoryRunJob): FactoryRunScope => ({
    runId: job.run.id,
    userId: job.factory.userId,
    projectId: job.factory.projectId,
    repo: job.repo,
    mode: job.mode,
    issueNumber: job.issue?.number ?? null,
    issueTitle: job.issue?.title ?? job.run.triggerName ?? flowOf(job),
    branch: factoryRunBranch(job.run),
    issueUrl: job.issue?.url,
  });

  /** The provider's reads and writes of the run's issue; they do nothing for a run without one. */
  function issueDepsOf(job: FactoryRunJob, scope: FactoryRunScope) {
    return {
      issueLabels: job.issue?.labels ?? [],
      issueUpdatedAt: async () => {
        if (scope.issueNumber === null) return null;
        const issue = await deps.github.getIssue(
          { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
          scope.issueNumber,
        );
        return issue.isOk() ? (issue.value.updatedAt ?? null) : null;
      },
      issueText: async () => {
        if (scope.issueNumber === null) return null;
        const text = await deps.github.issueText(
          { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
          scope.issueNumber,
        );
        return text.isOk() ? text.value : null;
      },
      releaseIssue: async () => {
        if (scope.issueNumber === null) return;
        const relabelled = await deps.github.relabelIssue(
          { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
          scope.issueNumber,
          { remove: job.factory.label || undefined, add: NO_CHANGE_TRIAGE_LABEL },
        );
        if (relabelled.isErr()) {
          log.warn('Issue factory could not relabel an issue that ended with no change', {
            namespace: 'factory',
            runId: job.run.id,
            issue: scope.issueNumber,
            error: relabelled.error.message,
          });
        }
      },
    };
  }

  /**
   * What the factory's `split` setting needs, or nothing (comment the split):
   * part issues are opened as the App with the token capped by the enabler,
   * like every other write of the run, and queued with the run's own flow.
   */
  function splitDepsOf(job: FactoryRunJob, scope: FactoryRunScope): FactorySplitDeps | undefined {
    const open = deps.github.createIssue;
    const parent = scope.issueNumber;
    if (job.factory.tooBig !== 'split' || !open || parent === null) return undefined;
    const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
    return {
      openIssue: async (issue) => {
        const created = await open(reader, issue);
        return created.isOk() ? ok(created.value.number) : err(created.error.message);
      },
      queue: async (issueNumbers) => {
        if (issueNumbers.length === 0) return;
        const queued = await deps.runs.enqueue({
          factoryId: job.factory.id,
          issueNumbers,
          flowName: flowOf(job),
        });
        if (queued.isErr()) {
          log.warn('Issue factory could not queue the parts of a split issue', {
            namespace: 'factory',
            runId: job.run.id,
            issues: issueNumbers,
            error: queued.error.message,
          });
        }
      },
      release: async (complete) => {
        const relabelled = await deps.github.relabelIssue(reader, parent, {
          remove: job.factory.label || undefined,
          add: complete ? undefined : NO_CHANGE_TRIAGE_LABEL,
        });
        if (relabelled.isErr()) {
          log.warn('Issue factory could not take its label off a split issue', {
            namespace: 'factory',
            runId: job.run.id,
            issue: parent,
            error: relabelled.error.message,
          });
        }
      },
    };
  }

  /**
   * Fail a run without an issue whose flow cannot run that way, before any
   * thread. The flow is read again for every run: it may have gained an
   * issue-only step or a required input since its trigger was saved.
   */
  async function refusedWithoutIssue(job: FactoryRunJob, flow: FactoryFlow): Promise<boolean> {
    if (job.issue !== null) return false;
    const problems = validateFlowForIssuelessRun(flow.workflow, Object.keys(job.run.inputs));
    if (problems.length === 0) return false;
    await deps.runs.updateInFlight(job.run.id, {
      state: 'failed',
      currentStep: null,
      failureReason: formatFactoryFlowProblems(`The flow "${flowOf(job)}"`, problems),
    });
    return true;
  }

  async function execute(
    job: FactoryRunJob,
    controller: AbortController,
    agentStarted: () => void,
  ): Promise<FactoryRunStart> {
    const projectDefaults = await projectAgentDefaults(job.factory.projectId);
    const flow = await loadFlow(job, {
      project: projectDefaults,
      overrides: job.factory.stepOverrides,
      batch: job.factory.batch,
      dependencies: job.factory.dependencies,
    });
    if (flow.isErr()) {
      await flowUnavailable(job, flow.error);
      return 'not-started';
    }
    logFlowWarnings(job, flow.value);
    if (await refusedWithoutIssue(job, flow.value)) return 'not-started';
    priorities.set(job.run.id, admissionPriority(job.run));
    mergeOrder.set(job.run.id, { blocker: await blocksOthers(job) });
    stageLimits.set(job.factory.id, job.factory.stageLimits);
    const trace: FlowTrace = {
      agentsRan: job.run.threadIds.length > 0,
      prOpen: job.run.prUrl !== null,
      held: false,
      step: null,
      parked: false,
      ended: false,
    };
    if (trace.agentsRan) agentStarted();

    const record = async (input: UpdateRunInput): Promise<void> => {
      // A stopped flow writes nothing more: its run may already be retried.
      if (controller.signal.aborted) return;
      const live = await deps.runs.updateInFlight(job.run.id, input);
      // Stopped (or finished) elsewhere: stop driving it.
      if (live.isOk() && !live.value) controller.abort();
      if (live.isOk() && live.value && input.state === 'merged') cleanUpMerged(job);
      // The tick that admitted the run waits for its implementing thread, so a
      // launch that fails frees its slot in the same tick. While triage runs
      // first that wait ends at the watcher's own limit (`ADMIT_WAIT_MS`).
      if (traceRecorded(trace, input)) agentStarted();
    };

    // The thread view draws the run's step chain from these.
    await record({ flowSteps: flow.value.pipeline.nodes.map((node) => node.name) });
    // Where the flow came from: written when the run first starts and on a
    // retry (it runs the flow as read now); a resumed run keeps what it had.
    if (job.run.flowSource === null || wasReopened(job)) {
      await record({ flowSource: flow.value.source, flowCommit: flow.value.commit });
    }
    // What each agent step ran with, after the steps an earlier attempt recorded.
    const stepOptions = [...job.run.stepOptions];

    // A run with journal rows resumes through them; one without replays `threadIds`.
    const journaled = await journalRows.load(job.run.id);
    if (journaled.isErr()) {
      log.warn('Issue factory run journal could not be read', {
        namespace: 'factory',
        runId: job.run.id,
        error: journaled.error.message,
      });
      return trace.agentsRan ? 'started' : 'not-started';
    }

    const scope = scopeOf(job);
    const provider = createFactoryActionProvider({
      projectDefaults,
      // Read at every agent step: a change saved mid-run reaches the steps not started yet.
      stepOverrides: async () =>
        (await getWatchedFactory(job.factory.id))?.stepOverrides ?? job.factory.stepOverrides,
      recordStepOptions: async (entry) => {
        stepOptions.push(entry);
        await record({ stepOptions: [...stepOptions] });
      },
      scope,
      threadIds: job.run.threadIds,
      prUrl: job.run.prUrl,
      metrics: job.run.metrics,
      launchStartedAt: job.run.launchStartedAt,
      findLaunched: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since),
      abandon: async (threadId) => deps.stopThreads?.(scope.userId, [threadId]),
      launch: (body) => deps.launch({ userId: scope.userId, body }),
      waitThread,
      continuation: continuationFor(scope),
      github: deps.github,
      ...integrationDepsFor(job, scope, controller.signal),
      defaultBranch: () =>
        deps.github.defaultBranch({
          repo: scope.repo,
          ownerId: scope.userId,
          projectId: scope.projectId,
        }),
      ...issueDepsOf(job, scope),
      split: splitDepsOf(job, scope),
      sensitivePaths: job.factory.sensitivePaths,
      maxLowRiskLines: job.factory.maxLowRiskLines,
      sizeIgnoredPaths: job.factory.sizeIgnoredPaths,
      autoMerge: job.factory.autoMerge,
      // Read from the row: the member approves while the run waits.
      mergeApproved: async (sha) => {
        const run = await deps.runs.get(job.run.id);
        return run.isOk() && run.value?.mergeApproval?.sha === sha;
      },
      carryMergeApproval: async (from, to) => {
        const carried = await deps.runs.carryMergeApproval(job.run.id, from, to);
        if (carried.isErr()) {
          log.warn('Issue factory could not carry the merge approval to the merged base', {
            namespace: 'factory',
            runId: job.run.id,
            from,
            to,
            error: carried.error.message,
          });
        }
      },
      storedProof: job.run.regressionProof,
      triage: job.run.triage,
      findTriageThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
      busyPaths: async () => {
        const others = await deps.runs.inFlight(job.factory.id);
        return others.isOk()
          ? busyPathsOf(others.value, job.run.id, job.run.stackedOn?.runId ?? null)
          : [];
      },
      holdForPaths: async (blockers) => {
        const held = await deps.runs.holdForPaths(job.run.id, blockers);
        if (held.isErr() || !held.value) return false;
        trace.held = true;
        return true;
      },
      exclusive: (work) => pathChecks.run(job.factory.id, work),
      reviews: job.run.reviews,
      admittedAt: job.run.admittedAt ?? job.run.startedAt,
      findReviewThread: (titlePrefix, since) => findLaunchedThread(scope, titlePrefix, since, true),
      reviewSlot: async (holder, signal) => {
        const grant = await gate.acquire({
          group: stageGroup('review', job.factory.id),
          limit: DEFAULT_STAGE_LIMIT,
          holder: `${job.run.id}/review/${holder}`,
          signal,
          onWait: () => {},
        });
        return grant.kind === 'slot' ? grant.release : () => {};
      },
      otherPullRequests: async () => {
        const others = await deps.runs.inFlight(job.factory.id);
        if (others.isErr()) return [];
        return others.value.flatMap((other) =>
          other.id !== job.run.id && other.prUrl ? [other.prUrl] : [],
        );
      },
      enterStage: async (stage) => {
        const entered = await deps.runs.enterStage(job.run.id, stage);
        // Stopped or parked elsewhere: stop driving it.
        if (entered.isOk() && !entered.value) controller.abort();
      },
      lastThreadMessage: deps.lastThreadMessage ?? lastThreadMessage,
      removeUnchangedWorktrees: async () => {
        const run = await deps.runs.get(job.run.id);
        const ids = run.isOk() && run.value ? run.value.threadIds : job.run.threadIds;
        return (await deps.cleanupUnchanged?.(scope.userId, ids)) ?? [];
      },
      proof: proofFor(scope),
      steps: deps.steps?.(scope.userId),
      integrateConfig: flow.value.integrate,
      flowIntegrates: flow.value.workflow.nodes.some((node) => node.integrate),
      record,
      signal: controller.signal,
      legacyReplay: journaled.value.length === 0,
    });

    // The branch the pull request merges into names the merge lane. Unknown
    // (GitHub could not be read): the lane is the repository's, which still
    // merges one at a time.
    const base = await deps.github.defaultBranch({
      repo: scope.repo,
      ownerId: scope.userId,
      projectId: scope.projectId,
    });
    const baseBranch = base.isOk() ? base.value : '';

    const context: YamlPipelineContext = {
      provider,
      progress: nullReporter,
      cwd: '',
      inputs: flowInputsOf(job, {
        branch: scope.branch,
        baseBranch,
        // A stacked run's blocker branch, for its prompts (D10); its merge group stays the base's.
        stackBranch: job.run.stackedOn?.retargeted ? '' : (job.run.stackedOn?.branch ?? ''),
      }),
      outputs: {},
    };
    const result = await runPipeline(flow.value.pipeline, context, {
      signal: controller.signal,
      runId: job.run.id,
      gate,
      journal: databaseJournal(journalRows, journalCodec(context)),
      onStateChange: (change) => {
        // A node waiting for its group's slot (a merge behind another run's)
        // is the run's current step too, though it has not entered yet.
        if (change.kind !== 'entering' && change.kind !== 'waiting_slot') return;
        // Waiting for a stage's slot, the run is admitted and holds its place:
        // the tick that admitted it does not wait for the slot.
        if (change.kind === 'waiting_slot') agentStarted();
        trace.step = change.nodeName;
        void record({ currentStep: change.nodeName });
      },
    });
    // A stop or a shutdown fails the step in flight; that is not the flow failing.
    const outcome = controller.signal.aborted ? 'cancelled' : result.outcome;
    await settle(job, outcome, trace, result.error);
    return trace.agentsRan ? 'started' : 'not-started';
  }

  return {
    /**
     * Run (or resume) a run's flow. Resolves once its first agent thread is
     * recorded — the run holds a slot — or the flow ended without one; the
     * flow itself goes on in the background.
     */
    start(job: FactoryRunJob): Promise<FactoryRunStart> {
      if (active.has(job.run.id)) return Promise.resolve('started');
      const controller = new AbortController();
      active.set(job.run.id, controller);
      let ready!: (start: FactoryRunStart) => void;
      const started = new Promise<FactoryRunStart>((resolve) => (ready = resolve));
      execute(job, controller, () => ready('started'))
        .then(ready, (cause: unknown) => {
          log.error('Issue factory flow crashed', {
            namespace: 'factory',
            runId: job.run.id,
            error: errorMessage(cause),
          });
          ready('not-started');
        })
        .finally(() => {
          if (active.get(job.run.id) === controller) active.delete(job.run.id);
          priorities.delete(job.run.id);
          mergeOrder.delete(job.run.id);
          earlyOf.delete(job.run.id);
        });
      return started;
    },

    isActive: (runId: string) => active.has(runId),

    /**
     * Integrate a running flow's branch early (D8): the base moved and its pull
     * request no longer merges. `not-running`: no flow of this server drives it.
     */
    earlyIntegrate(runId: string): Promise<EarlyOutcome | 'not-running'> {
      const early = earlyOf.get(runId);
      return early ? early.request() : Promise.resolve('not-running');
    },

    /** Take the factory's stage limits as saved now (each tick): they apply to the next slot asked for. */
    noteFactory(factory: Pick<WatchedFactory, 'id' | 'stageLimits'>): void {
      stageLimits.set(factory.id, factory.stageLimits);
    },

    /** Stop driving one run's flow (the run was stopped); nothing more is written for it. */
    stop(runId: string): void {
      // It stays active until its flow returns, so a retry cannot start a
      // second flow for the run while this one is still unwinding.
      active.get(runId)?.abort();
    },

    /** Stop driving every flow (shutdown); their runs resume on the next start. */
    stopAll(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
      // Leases this server held expire unrenewed; another server takes over.
      stopGate();
    },
  };
}
