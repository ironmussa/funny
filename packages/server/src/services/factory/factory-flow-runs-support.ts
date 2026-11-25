/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The parts of `factory-flow-runs.ts` that do not hold a flow run's state:
 * its job and dependency types, how a run is named and ordered in a group's
 * queue, the journal codec, the concurrency gate, and the database reads that
 * find what an interrupted launch started.
 */

import type { ConcurrencyGate, MemoryGateOptions } from '@funny/pipelines';
import type { NodeOutput, YamlPipelineContext } from '@funny/workflows/compiler';
import { and, asc, desc, eq, gte, like } from 'drizzle-orm';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { messages, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { recordServerActivity } from '../activities/server-activities.js';
import type {
  StartedThread,
  StartThreadError,
  StartThreadInput,
} from '../runner-thread-launcher.js';
import type { JournalCodec } from '../workflow-engine/journal-repository.js';
import { createLeaseGate } from '../workflow-engine/lease-gate.js';
import type {
  FactoryProofDeps,
  FactoryThreadMode,
  StepAgentBody,
} from './factory-action-provider.js';
import { approvalMoveTitle, type ApprovalMove } from './factory-approval-carry.js';
import type { FactoryBatchesRepository } from './factory-batches.js';
import type { FactoryFlowContext, FactoryFlow, FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import {
  REOPENED_STEP,
  type createFactoryRunsRepository,
  type FactoryRunView,
  type UpdateRunInput,
} from './factory-runs.js';
import type { WatchedFactory } from './factory-settings.js';
import type { FactoryStepDeps } from './factory-step-runner.js';
import type { KeptWorktree } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

export interface FactoryRunJob {
  factory: WatchedFactory;
  repo: string;
  mode: FactoryThreadMode;
  /** The run's issue as GitHub has it; null for a run without one (change flow-triggers). */
  issue: FactoryIssue | null;
  run: FactoryRunView;
}

/** A merge approval the factory moved to another commit, as a row of the approver's activities. */
export function recordApprovalMove(
  move: ApprovalMove,
  projectId: string,
  issueNumber: number | null,
): Promise<void> {
  return recordServerActivity(
    {
      kind: 'factory.approval-moved',
      userId: move.userId,
      projectId,
      title: approvalMoveTitle(move, issueNumber),
      input: {
        ...(typeof issueNumber === 'number' && { issueNumber }),
        from: move.from,
        to: move.to,
        change: move.kind,
        lines: move.lines,
        files: move.files.slice(0, 20),
        ...(move.baseFiles.length > 0 && { baseFiles: move.baseFiles.slice(0, 20) }),
      },
      origin: 'system',
    },
    { ok: true },
  );
}

export interface FactoryFlowRunsDeps {
  runs: ReturnType<typeof createFactoryRunsRepository>;
  github: FactoryGithubPort;
  launch(input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>>;
  waitThread?: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /**
   * The wait of a read-only role (triage, review), which also reports an answer
   * left in a turn that never ended as `idle`. Defaults to `waitThread` when a
   * test gives one, else to the stored threads with `ROLE_QUIET_ANSWER_MS`.
   */
  waitRoleThread?: (
    threadId: string,
    signal: AbortSignal,
    after?: WaitAfter,
  ) => Promise<ThreadOutcome>;
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
    options?: Partial<StepAgentBody>,
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
   * The run merged: close the pull requests of its issue's earlier runs that
   * ended without merging (best effort, never throws). `repo` when known.
   */
  closeSuperseded?: (runId: string, repo?: string) => Promise<void>;
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
export interface FlowTrace {
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
export function traceRecorded(trace: FlowTrace, input: UpdateRunInput): boolean {
  if (input.prUrl) trace.prOpen = true;
  if (input.state === 'waiting_human') trace.parked = true;
  if (input.state === 'needs_info') trace.held = true;
  if (input.state === 'no_change' || input.state === 'done') trace.ended = true;
  if (!input.threadIds) return false;
  trace.agentsRan = true;
  return true;
}

export function logFlowWarnings(job: FactoryRunJob, flow: FactoryFlow): void {
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

export async function threadCompletedAt(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ completedAt: threads.completedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.completedAt ?? null;
}

/** A user message on the thread since `since`: an interrupted follow-up reached it. */
export async function followedUpSince(threadId: string, since: string): Promise<boolean> {
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
export async function findLaunchedThread(
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
export const subjectOf = (job: FactoryRunJob): string =>
  job.issue ? `Issue #${job.issue.number}` : `"${job.run.triggerName ?? flowOf(job)}"`;

/** Flow input name → value. */
interface FlowInputs {
  [name: string]: string;
}

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
): FlowInputs {
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
export const wasReopened = (job: FactoryRunJob) => job.run.currentStep === REOPENED_STEP;

/** What the thread view says about a failed run: the flow's error. */
export const failureReason = (error: string | undefined): string =>
  error?.trim() || 'The flow failed.';

/**
 * The flow the run executes: the one it recorded (chosen when the issue was
 * sent, or the factory's at admission), else the factory's for rows from
 * before runs recorded their own.
 */
export const flowOf = (job: FactoryRunJob): string => job.run.flowName ?? job.factory.flowName;

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

/** The flow's step outputs by node id, as a journal stores them. */
interface StoredOutputs {
  [nodeId: string]: NodeOutput;
}

/**
 * The journal keeps the flow's step outputs; the rest of the context (the
 * provider, the progress reporter, the inputs) is this attempt's, rebuilt by
 * the server that resumes the run.
 */
export const journalCodec = (
  live: YamlPipelineContext,
): JournalCodec<YamlPipelineContext, StoredOutputs> => ({
  encode: (ctx) => ctx.outputs,
  decode: (stored) => ({ ...live, outputs: STORED_OUTPUTS.parse(stored) }),
});

/** The gate a flow run waits on, and how to stop renewing its leases. */
interface FlowGate {
  gate: ConcurrencyGate;
  stop: () => void;
}

/** The given gate, or this server's lease gate with how to stop renewing its leases. */
export function flowGate(
  given: ConcurrencyGate | undefined,
  rules: Pick<MemoryGateOptions, 'resolveLimit' | 'priority'>,
): FlowGate {
  if (given) return { gate: given, stop: () => {} };
  const leases = createLeaseGate(rules);
  return { gate: leases, stop: () => leases.stop() };
}

/** How many runs of a factory may be inside a stage at once, unless the flow or the factory says. */
export const DEFAULT_STAGE_LIMIT = 20;

/** The concurrency group of a stage of one factory (`<node>:<factoryId>`). */
export const stageGroup = (stage: string, factoryId: string) => `${stage}:${factoryId}`;

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
export const GONE_STATES: ReadonlySet<string> = new Set(['failed', 'stopped', 'no_change']);

/**
 * Per factory, one triage contract-and-paths check at a time (in this process,
 * like the watcher), as slot writes are serialized in `factory-runs.ts`: two
 * runs triaged together would otherwise each miss the other's paths.
 */
export const pathChecks = (() => {
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
