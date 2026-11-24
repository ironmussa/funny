/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * The shapes a factory run's flow is driven with (`factory-flow-runs.ts`):
 * the job, the host's dependencies, and what the flow left behind for its end.
 */

import type { ConcurrencyGate } from '@funny/pipelines';
import type { Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type {
  StartedThread,
  StartThreadError,
  StartThreadInput,
} from '../runner-thread-launcher.js';
import type { FactoryProofDeps, FactoryThreadMode } from './factory-action-provider.js';
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
  notify?: (userId: string, message: WaitingNotice) => Promise<unknown>;
  /**
   * Grants the flows' concurrency-group slots. Default: database leases shared
   * by every server instance (`createLeaseGate`), stopped by `stopAll`, so
   * `merge-{{inputs.repo}}` with limit 1 merges one pull request at a time
   * per repository however many servers run.
   */
  gate?: ConcurrencyGate;
}

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

/** How a run is named to a person: its issue, or its trigger (or flow) without one. */
export const subjectOf = (job: FactoryRunJob): string =>
  job.issue ? `Issue #${job.issue.number}` : `"${job.run.triggerName ?? flowOf(job)}"`;

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
