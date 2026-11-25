/**
 * The issue-factory watcher's process state (`factory-watcher.ts`): its
 * dependencies, the repositories it acts through while it runs, and the
 * helpers every part of the watcher shares.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { ConcurrencyGate } from '@funny/pipelines';
import { type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { CreationPayload } from '../../modules/threads/index.js';
import { type ServerActivities } from '../activities/server-activities.js';
import {
  startThreadOnRunner,
  type RunnerPorts,
  type StartedThread,
  type StartThreadError,
  type StartThreadInput,
} from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import type { FactoryThreadMode, StepAgentBody } from './factory-action-provider.js';
import {
  createFactoryFlowRuns,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type WaitingNotice,
} from './factory-flow-runs.js';
import { type FactoryFlow, type FactoryFlowError } from './factory-flow.js';
import { type FactoryGithubPort } from './factory-github.js';
import { type FactoryIncidentsRepository } from './factory-incidents.js';
import { createFactoryRunsRepository, IN_FLIGHT_STATES } from './factory-runs.js';
import { setFactoryBlocked } from './factory-settings.js';
import {
  type BrowserEventsPort,
  cleanupFactoryWorktrees,
  type KeptWorktree,
} from './factory-thread-requests.js';
import { type ThreadOutcome, type WaitAfter } from './factory-thread-waits.js';
import { type FactoryTriggersRepository } from './factory-triggers.js';

/** The in-flight states, widened so a stored state string can be looked up. */
export const IN_FLIGHT: readonly string[] = IN_FLIGHT_STATES;

/** A repeating poll — a real interval in production, a fake in tests. */
export interface FactoryPoll {
  stop(): void;
}

/** `onTick` settles when the tick is done and never rejects. */
export type CreatePoll = (onTick: () => Promise<void>) => FactoryPoll;

export interface FactoryWatcherDeps {
  ports: RunnerPorts;
  github: FactoryGithubPort;
  runs?: ReturnType<typeof createFactoryRunsRepository>;
  createPoll?: CreatePoll;
  /** Launcher override for tests. */
  launch?: typeof startThreadOnRunner;
  /** Access check override for tests; defaults to `steer` via the server's role resolver. */
  checkAccess?: (userId: string, projectId: string) => Promise<boolean>;
  /** Records what the watcher does on its own (default: the server's activities). */
  activities?: Pick<ServerActivities, 'recordServerActivity'>;
  /**
   * Start a sandbox thread for the enabler (the sandbox thread launcher of
   * `thread-sandboxes`, with their own connection). Without it a sandbox
   * runtime is skipped, never run elsewhere.
   */
  launchSandbox?: (
    userId: string,
    body: CreationPayload,
  ) => Promise<Result<StartedThread, StartThreadError>>;
  /** Override for tests of `runsPushedCommits` (whether the thread is isolated in a sandbox). */
  runsPushedCommits?: (threadId: string) => Promise<boolean>;
  /** Runtime resolver override for tests; defaults to the enabler's `project_sandbox_settings`. */
  resolveRuntime?: (userId: string, projectId: string) => Promise<ThreadRuntimeMode>;
  /** Thread wait override for tests; defaults to the DB status plus the terminal signal. */
  waitThread?: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /** Last assistant message override for tests; defaults to the stored one. */
  lastThreadMessage?: (threadId: string) => Promise<string | null>;
  /** Incidents repository override for tests; defaults to the database's. */
  incidents?: FactoryIncidentsRepository;
  /** Follow-up override for tests; defaults to a message on the thread's runner, as the enabler. */
  followUp?: (
    userId: string,
    threadId: string,
    content: string,
    expectedBranch?: string,
    /** The step's agent options, carried on the message body. */
    options?: Partial<StepAgentBody>,
  ) => Promise<Result<void, string>>;
  /** Where the merged-run cleanup tells the enabler's browsers about the cleared threads. */
  browserEvents?: BrowserEventsPort;
  /** Merged-run cleanup override for tests; defaults to `cleanupFactoryWorktrees`. */
  cleanupMerged?: (userId: string, threadIds: string[]) => Promise<void>;
  /** "No change" cleanup override for tests; defaults to `cleanupFactoryWorktrees` keeping unsaved work. */
  cleanupUnchanged?: (userId: string, threadIds: string[]) => Promise<KeptWorktree[]>;
  /** Notification override for tests; defaults to Web Push. */
  notify?: (userId: string, message: WaitingNotice) => Promise<unknown>;
  /** Flow loader override for tests; defaults to the default branch, then the built-ins. */
  loadFlow?: (job: FactoryRunJob) => Promise<Result<FactoryFlow, FactoryFlowError>>;
  /** Proof service override for tests; defaults to runner thread requests. */
  proof?: FactoryFlowRunsDeps['proof'];
  /** Factory step override for tests; defaults to the enabler's runner. */
  steps?: FactoryFlowRunsDeps['steps'];
  /** The flows' concurrency gate (tests); default: database leases. */
  gate?: ConcurrencyGate;
  /** Schedule triggers repository override for tests; defaults to the database's. */
  triggers?: FactoryTriggersRepository;
  /** Clock override for tests (schedule triggers). */
  now?: () => Date;
}

export let deps: FactoryWatcherDeps | null = null;
export let runs: ReturnType<typeof createFactoryRunsRepository> | null = null;
export let flows: ReturnType<typeof createFactoryFlowRuns> | null = null;
/** The proof service of a thread, as the enabler (the watcher's, or the test's). */
export let proofs: NonNullable<FactoryWatcherDeps['proof']> | null = null;

/** What the watcher acts through while it runs (null: it is stopped). */
interface WatcherState {
  deps: FactoryWatcherDeps | null;
  runs: ReturnType<typeof createFactoryRunsRepository> | null;
  flows: ReturnType<typeof createFactoryFlowRuns> | null;
  proofs: NonNullable<FactoryWatcherDeps['proof']> | null;
}

/** Set (or, with nulls, clear) the given parts of the watcher's state. */
export function setWatcherState(next: Partial<WatcherState>): void {
  if ('deps' in next) deps = next.deps ?? null;
  if ('runs' in next) runs = next.runs ?? null;
  if ('flows' in next) flows = next.flows ?? null;
  if ('proofs' in next) proofs = next.proofs ?? null;
}

/** The thread modes phase 2 can launch. */
export type LaunchMode = FactoryThreadMode;

/** Last reason written per factory, so a steady state writes nothing each tick. */
export const blockedReasons = new Map<string, string | null>();

/** Record why the factory cannot make progress (null: it can), when it changed. */
export async function reportBlocked(factoryId: string, reason: string | null): Promise<void> {
  if (blockedReasons.has(factoryId) && blockedReasons.get(factoryId) === reason) return;
  blockedReasons.set(factoryId, reason);
  await setFactoryBlocked(factoryId, reason).catch((error: unknown) =>
    log.warn('Failed to record why an issue factory is blocked', {
      namespace: 'factory',
      factoryId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Remove a merged run's worktrees: the test override, else on the enabler's runner. */
export function cleanupMergedFor(
  d: FactoryWatcherDeps,
  userId: string,
  threadIds: string[],
): Promise<void> {
  return d.cleanupMerged
    ? d.cleanupMerged(userId, threadIds)
    : cleanupFactoryWorktrees(d.ports, userId, threadIds, d.browserEvents).then(() => undefined);
}

/**
 * Start a run's agent thread where the enabler's runtime says: a sandbox thread
 * on their own sandbox connection, or a local / worktree thread on their runner.
 */
export function launchFor(d: FactoryWatcherDeps) {
  return async (input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>> => {
    const { mode, ...body } = input.body;
    if (mode === 'sandbox' && d.launchSandbox) {
      return d.launchSandbox(input.userId, { ...body, source: 'factory' });
    }
    return (d.launch ?? startThreadOnRunner)(input, d.ports);
  };
}
