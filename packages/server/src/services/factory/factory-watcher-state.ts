/**
 * The issue-factory watcher's process-wide state (`factory-watcher.ts`): its
 * dependencies and the services built from them while it runs, shared with
 * the admission (`factory-watcher-admission.ts`) and parked-run
 * (`factory-watcher-parked.ts`) passes.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { ConcurrencyGate } from '@funny/pipelines';
import type { Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { ServerActivities } from '../activities/server-activities.js';
import type {
  RunnerPorts,
  StartedThread,
  StartThreadError,
  startThreadOnRunner,
} from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import type {
  createFactoryFlowRuns,
  FactoryFlowRunsDeps,
  FactoryRunJob,
  WaitingNotice,
} from './factory-flow-runs.js';
import type { FactoryFlow, FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort } from './factory-github.js';
import type { FactoryIncidentsRepository } from './factory-incidents.js';
import type { createFactoryRunsRepository } from './factory-runs.js';
import { setFactoryBlocked } from './factory-settings.js';
import type { BrowserEventsPort, KeptWorktree } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';
import type { FactoryTriggersRepository } from './factory-triggers.js';

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
    body: Record<string, unknown>,
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
    options?: Record<string, unknown>,
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

/** What the watcher holds while it runs (all null while it is stopped). */
interface WatcherState {
  deps: FactoryWatcherDeps | null;
  runs: ReturnType<typeof createFactoryRunsRepository> | null;
  flows: ReturnType<typeof createFactoryFlowRuns> | null;
  /** The proof service of a thread, as the enabler (the watcher's, or the test's). */
  proofs: NonNullable<FactoryWatcherDeps['proof']> | null;
}

/** Read at each use, so a stop during a tick is seen by the rest of that tick. */
export const watcher: WatcherState = { deps: null, runs: null, flows: null, proofs: null };

/** Last reason written per factory, so a steady state writes nothing each tick. */
const blockedReasons = new Map<string, string | null>();

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

/** Forget the recorded reasons (the watcher stopped). */
export function forgetBlockedReasons(): void {
  blockedReasons.clear();
}
