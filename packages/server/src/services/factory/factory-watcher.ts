/**
 * Server-owned issue-factory watcher (change issue-factory, phase 2; flows in
 * factory-flow-execution).
 *
 * Holds one polling job per enabled factory and, on each tick, resolves the
 * project's GitHub repo, admits the issues sent to the factory (its queue, in
 * the order they were sent) and, in automatic mode, then its open labelled
 * issues — the ones not already running, not blocked by an unfinished issue
 * (`factory-dependencies.ts`) and under the concurrency cap — and runs each run's flow
 * for each as the ENABLING user (`factory-flow-runs.ts`): its agent steps are
 * threads started through `startThreadOnRunner` — the same path interactive
 * threads take, so runner isolation and the project ↔ runner binding apply
 * unchanged. Each admitted issue becomes a `factory_runs` row; a run in flight
 * whose flow is not running in this process (a restart) is resumed by the
 * next tick.
 *
 * Single-instance assumption (shared with the automation scheduler): every
 * server process that calls `startFactoryWatcher` polls every factory.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { IssueBlocker } from '@funny/core/github-app';
import type { ConcurrencyGate } from '@funny/pipelines';
import { sleep as interruptibleSleep } from '@funny/shared/async';
import type { FactoryWaitReason } from '@funny/shared/contracts/factory';
import type { RegressionProofOpts } from '@funny/workflows/compiler';
import { and, eq } from 'drizzle-orm';
import type { Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { projectSandboxSettings } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';
import { serverActivities, type ServerActivities } from '../activities/server-activities.js';
import {
  startThreadOnRunner,
  type RunnerPorts,
  type StartedThread,
  type StartThreadError,
  type StartThreadInput,
} from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import type { FactoryThreadMode } from './factory-action-provider.js';
import {
  sameWaitReason,
  unfinishedBlockers,
  waitReasonFor,
  type LatestRunState,
} from './factory-dependencies.js';
import {
  createFactoryFlowRuns,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type WaitingNotice,
} from './factory-flow-runs.js';
import { loadFactoryFlow, type FactoryFlow, type FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue, FactoryRepoReader } from './factory-github.js';
import {
  proofAllowsMerge,
  proofCheckOf,
  proofRecordOf,
  proveOnRunner,
  regressionTestRequired,
  type FactoryProofDeps,
} from './factory-proof-runner.js';
import { prNumberOf } from './factory-pull-requests.js';
import {
  createFactoryRunsRepository,
  factoryRunBranch,
  IN_FLIGHT_STATES,
  NO_FREE_SLOT,
  type FactoryRunState,
  type FactoryRunView,
  type RegressionProofRecord,
} from './factory-runs.js';
import {
  disableFactory,
  getWatchedFactory,
  setFactoryBlocked,
  listWatchedFactories,
  type WatchedFactory,
} from './factory-settings.js';
import {
  type BrowserEventsPort,
  cleanupFactoryWorktrees,
  cancelRegressionProofOnRunner,
  pollRegressionProofOnRunner,
  sendFactoryFollowUp,
  startRegressionProofOnRunner,
  stopFactoryThreads,
} from './factory-thread-requests.js';
import { runsPushedCommits, type ThreadOutcome, type WaitAfter } from './factory-thread-waits.js';

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
  /** Follow-up override for tests; defaults to a message on the thread's runner, as the enabler. */
  followUp?: (
    userId: string,
    threadId: string,
    content: string,
    expectedBranch?: string,
  ) => Promise<Result<void, string>>;
  /** Where the merged-run cleanup tells the enabler's browsers about the cleared threads. */
  browserEvents?: BrowserEventsPort;
  /** Merged-run cleanup override for tests; defaults to `cleanupFactoryWorktrees`. */
  cleanupMerged?: (userId: string, threadIds: string[]) => Promise<void>;
  /** Notification override for tests; defaults to Web Push. */
  notify?: (userId: string, message: WaitingNotice) => Promise<unknown>;
  /** Flow loader override for tests; defaults to the default branch, then the built-ins. */
  loadFlow?: (job: FactoryRunJob) => Promise<Result<FactoryFlow, FactoryFlowError>>;
  /** Proof service override for tests; defaults to runner thread requests. */
  proof?: FactoryFlowRunsDeps['proof'];
  /** The flows' concurrency gate (tests); default: database leases. */
  gate?: ConcurrencyGate;
}

/** How often each factory polls GitHub while the server is up. */
const POLL_INTERVAL_MS = 60 * 1000;

/** The production poll. `unref` keeps the timer from holding the process open. */
const startIntervalPoll: CreatePoll = (onTick) => {
  const timer = setInterval(() => void onTick(), POLL_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

/** How long admission waits for a run's first agent before counting it as started. */
const ADMIT_WAIT_MS = 15 * 1000;

/** Runs of an issue that may fail before the factory stops re-admitting it. */
export const MAX_ATTEMPTS = 3;

const jobs = new Map<string, FactoryPoll>();
/** Factories with a tick in progress: a slow tick is never overlapped by the next one. */
const busy = new Set<string>();
let deps: FactoryWatcherDeps | null = null;
let runs: ReturnType<typeof createFactoryRunsRepository> | null = null;
let flows: ReturnType<typeof createFactoryFlowRuns> | null = null;
/** The proof service of a thread, as the enabler (the watcher's, or the test's). */
let proofs: NonNullable<FactoryWatcherDeps['proof']> | null = null;
/** Parked runs whose new head is being proved now, by run id. */
const reproving = new Map<string, AbortController>();

/** The enabler's configured runtime for the project, or local when none is set. */
async function defaultResolveRuntime(
  userId: string,
  projectId: string,
): Promise<ThreadRuntimeMode> {
  const [row] = await db
    .select({ mode: projectSandboxSettings.mode })
    .from(projectSandboxSettings)
    .where(
      and(
        eq(projectSandboxSettings.projectId, projectId),
        eq(projectSandboxSettings.userId, userId),
      ),
    );
  return (row?.mode as ThreadRuntimeMode) ?? 'local';
}

// ── Lifecycle ────────────────────────────────────────────────────

export async function startFactoryWatcher(d: FactoryWatcherDeps): Promise<void> {
  stopFactoryWatcher();
  deps = d;
  runs = d.runs ?? createFactoryRunsRepository();
  proofs =
    d.proof ??
    ((userId, _threadId) => ({
      startProof: (tid, body) => startRegressionProofOnRunner(d.ports, userId, tid, body),
      pollProof: (tid, proofId) => pollRegressionProofOnRunner(d.ports, userId, tid, proofId),
      cancelProof: (tid, proofId) => cancelRegressionProofOnRunner(d.ports, userId, tid, proofId),
    }));
  flows = createFactoryFlowRuns({
    runs,
    github: d.github,
    launch: launchFor(d),
    waitThread: d.waitThread,
    loadFlow: d.loadFlow,
    notify: d.notify,
    gate: d.gate,
    proof: proofs,
    reportBlocked: (factoryId, reason) => reportBlocked(factoryId, reason),
    stopThreads: (userId, threadIds) => stopFactoryThreads(d.ports, userId, threadIds),
    cleanupMerged: (userId, threadIds) => cleanupMergedFor(d, userId, threadIds),
    followUp:
      d.followUp ??
      ((userId, threadId, content, expectedBranch) =>
        sendFactoryFollowUp(d.ports, userId, threadId, content, expectedBranch)),
  });
  for (const factory of await listWatchedFactories([...IN_FLIGHT_STATES])) schedule(factory);
  log.info('Issue factory watcher started', { namespace: 'factory', jobs: jobs.size });
}

export function stopFactoryWatcher(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  busy.clear();
  blockedReasons.clear();
  for (const controller of reproving.values()) controller.abort();
  reproving.clear();
  proofs = null;
  flows?.stopAll();
  flows = null;
  deps = null;
  runs = null;
}

/** Re-read a factory and (re)schedule it — call after a settings change. */
export async function rescheduleFactory(id: string): Promise<void> {
  unscheduleFactory(id);
  if (!deps) return;
  const factory = await getWatchedFactory(id);
  if (factory) schedule(factory);
}

/** Stop polling a factory — called internally after it is disabled or re-scheduled. */
function unscheduleFactory(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/** Number of scheduled polls (diagnostics / tests). */
export function scheduledFactoryCount(): number {
  return jobs.size;
}

/**
 * Look at a factory now instead of at its next poll, scheduling it if it was
 * not polled (a paused factory whose run was retried or taken over).
 */
export async function pokeFactory(id: string): Promise<void> {
  if (!deps) return;
  if (!jobs.has(id)) {
    const factory = await getWatchedFactory(id);
    if (!factory) return;
    schedule(factory);
  }
  await tick(id);
}

/** Stop driving a run's flow in this process (the run was stopped). */
export function stopFactoryFlow(runId: string): void {
  flows?.stop(runId);
}

/** The runner ports the watcher acts through, while it runs. */
export function factoryRunnerPorts(): RunnerPorts | null {
  return deps?.ports ?? null;
}

function schedule(factory: WatchedFactory): void {
  if (!deps || jobs.has(factory.id)) return;
  const job = (deps.createPoll ?? startIntervalPoll)(() => tick(factory.id));
  jobs.set(factory.id, job);
}

/** One poll. A rejection is logged here; it is never passed on to a timer. */
function tick(id: string): Promise<void> {
  if (busy.has(id)) {
    log.info('Issue factory tick skipped: the previous tick is still running', {
      namespace: 'factory',
      factoryId: id,
    });
    return Promise.resolve();
  }
  busy.add(id);
  return fire(id)
    .catch((error: unknown) => {
      log.error('Issue factory tick failed', {
        namespace: 'factory',
        factoryId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => busy.delete(id));
}

async function fire(id: string): Promise<void> {
  if (!deps || !runs) return;
  // Re-read so a disable or an edit that raced the tick is honored.
  const factory = await getWatchedFactory(id);
  if (!factory || !(await hasWork(factory))) {
    unscheduleFactory(id);
    return;
  }
  // Resuming and admitting both act as the enabler: both need their access.
  if (!(await enablerCanStillSteer(factory))) return;
  const target = await resolveTarget(factory);
  if (!target) return;
  // Reached the repository as the enabler: nothing blocks the factory (until
  // the listing or a launch below says otherwise).
  await reportBlocked(factory.id, null);
  await reconcileParked(factory, target.repo);
  await resumeRuns(factory, target.repo, target.mode);
  // A paused factory finishes its runs but admits nothing new; its queue waits.
  if (factory.enabled) await admitWork(factory, target.repo, target.mode);
}

/** Last reason written per factory, so a steady state writes nothing each tick. */
const blockedReasons = new Map<string, string | null>();

/** Record why the factory cannot make progress (null: it can), when it changed. */
async function reportBlocked(factoryId: string, reason: string | null): Promise<void> {
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

/**
 * An enabled factory, or a paused one with runs still in flight or a parked run
 * whose pull request a person may still merge or close (see `reconcileParked`).
 */
async function hasWork(factory: WatchedFactory): Promise<boolean> {
  if (factory.enabled) return true;
  const active = await runs!.countActive(factory.id);
  if (active.isErr() || active.value > 0) return true;
  const awaiting = await runs!.awaitingPullRequest(factory.id);
  return awaiting.isErr() || awaiting.value.length > 0;
}

/** Where a factory's runs execute now, or why they cannot. */
export type FactoryTarget = { mode: LaunchMode; repo: string } | { reason: string };

/**
 * Where the factory's runs execute: the enabler's runtime and the project's
 * repository, or why it cannot run now. A sandbox runtime runs its threads in
 * the enabler's sandbox; it is NOT downgraded to local when sandboxes cannot
 * be launched here (issue text is untrusted input, and the enabler chose
 * isolation): the factory then waits.
 */
async function targetOf(factory: WatchedFactory): Promise<FactoryTarget> {
  const mode = await resolveMode(factory.userId, factory.projectId);
  if (!mode) {
    return {
      reason:
        'Your runtime for this project is sandbox, and this server cannot start sandbox threads.',
    };
  }
  const repo = await deps!.github.resolveRepo(factory.userId, factory.projectId);
  if (!repo) {
    return {
      reason:
        "Waiting for your runner: the project's repository could not be read (is your runner online, and does the project have a GitHub origin?).",
    };
  }
  return { mode, repo };
}

/** The tick's target, or null (logged, and reported as the factory's block). */
async function resolveTarget(
  factory: WatchedFactory,
): Promise<{ mode: LaunchMode; repo: string } | null> {
  const target = await targetOf(factory);
  if ('reason' in target) {
    log.info('Issue factory tick skipped', {
      namespace: 'factory',
      factoryId: factory.id,
      projectId: factory.projectId,
      reason: target.reason,
    });
    await reportBlocked(factory.id, target.reason);
    return null;
  }
  return target;
}

/**
 * Where a factory's runs would execute right now, checked live (a send must not
 * trust a `blockedReason` up to a poll old). Null when the watcher is not
 * running in this process.
 */
export async function checkFactoryTarget(factory: WatchedFactory): Promise<FactoryTarget | null> {
  if (!deps) return null;
  return targetOf(factory);
}

/** The GitHub side the watcher reads through, while it runs. */
export function factoryGithubPort(): FactoryGithubPort | null {
  return deps?.github ?? null;
}

/** What one admission pass knows: the factory's runs, and the blockers read so far. */
interface AdmissionContext {
  reader: FactoryRepoReader;
  latestRuns: LatestRunState;
  /** Issues waiting in the queue (`requested`). */
  queued: ReadonlySet<number>;
  /** Blockers read this pass, by issue (null: unreadable). */
  blockers: Map<number, Promise<IssueBlocker[] | null>>;
  /** Whether each flow read this pass is proof-ready, by name. */
  proofReady: Map<string, Promise<boolean>>;
}

function admissionContext(
  factory: WatchedFactory,
  repo: string,
  all: FactoryRunView[],
): AdmissionContext {
  // `list` is newest first: the first run seen for an issue is its latest.
  const latestRuns = new Map<number, FactoryRunState>();
  for (const run of all)
    if (!latestRuns.has(run.issueNumber)) latestRuns.set(run.issueNumber, run.state);
  return {
    reader: { repo, ownerId: factory.userId, projectId: factory.projectId },
    latestRuns,
    queued: new Set(all.flatMap((run) => (run.state === 'requested' ? [run.issueNumber] : []))),
    proofReady: new Map(),
    blockers: new Map(),
  };
}

/** An issue's blockers, read once per pass. */
function blockersOf(ctx: AdmissionContext, issue: number): Promise<IssueBlocker[] | null> {
  let read = ctx.blockers.get(issue);
  if (!read) {
    read = Promise.resolve(deps!.github.issueBlockers(ctx.reader, issue)).then((result) =>
      result.isOk() ? result.value : null,
    );
    ctx.blockers.set(issue, read);
  }
  return read;
}

/**
 * Why `issue` must wait for its blockers, or null when it may start. The cycle
 * check follows the unfinished blockers that are themselves waiting in the
 * queue (each read once per pass).
 */
async function blockedReason(
  ctx: AdmissionContext,
  issue: number,
): Promise<FactoryRunView['waitReason']> {
  const blockers = await blockersOf(ctx, issue);
  const graph = new Map<number, number[]>();
  const pending = [issue];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (graph.has(next)) continue;
    const own = next === issue ? blockers : await blockersOf(ctx, next);
    const edges = own ? unfinishedBlockers(ctx.reader.repo, own, ctx.latestRuns).sameRepo : [];
    graph.set(next, edges);
    pending.push(...edges.filter((n) => ctx.queued.has(n) && !graph.has(n)));
  }
  return waitReasonFor({
    repo: ctx.reader.repo,
    issue,
    blockers,
    latestRuns: ctx.latestRuns,
    queueGraph: graph,
  });
}

/** How many more runs may start now (0 when the count cannot be read). */
async function freeSlots(factory: WatchedFactory): Promise<number> {
  const active = await runs!.countActive(factory.id);
  if (active.isOk()) return factory.maxConcurrent - active.value;
  log.warn('Issue factory could not read active runs', {
    namespace: 'factory',
    factoryId: factory.id,
    error: active.error.message,
  });
  return 0;
}

/**
 * Fill the free slots: first the issues sent to the factory, in the order they
 * were sent, then (automatic mode) its labelled issues. A blocked issue is
 * skipped, not waited on, so it does not hold up the ones behind it.
 */
async function admitWork(factory: WatchedFactory, repo: string, mode: LaunchMode): Promise<void> {
  const slots = runs ? await freeSlots(factory) : 0;
  if (slots <= 0) return;
  const all = await runs!.list(factory.id);
  const queue = await runs!.queue(factory.id);
  if (all.isErr() || queue.isErr()) return;
  const ctx = admissionContext(factory, repo, all.value);

  const left = await admitQueue(factory, repo, mode, queue.value, slots, ctx);
  if (factory.mode !== 'automatic' || left <= 0) return;
  // A flow that could never merge admits nothing; runs in flight go on.
  if (!(await flowProofReady(ctx, factory.flowName))) {
    await reportBlocked(factory.id, proofNotConfigured(factory.flowName));
    return;
  }
  await admitFromGithub(factory, repo, mode, left, ctx);
}

/** The factory blocker of a flow that is not proof-ready. */
const proofNotConfigured = (flowName: string) =>
  `Regression proof not configured: the flow "${flowName}" has no regression_proof rules, so it would never merge. Add rules to .funny/workflows/${flowName}.yaml on the default branch, or set require_regression_proof: false on its merge step.`;

/**
 * Whether the flow `name` may merge (`FactoryFlow.proofReady`), read once per
 * pass. A flow that cannot be loaded now is not held back here: its run
 * reports why it failed to load.
 */
function flowProofReady(ctx: AdmissionContext, name: string): Promise<boolean> {
  let ready = ctx.proofReady.get(name);
  if (!ready) {
    ready = loadFactoryFlow(name, {
      readDefaultBranchFile: (path) => deps!.github.readDefaultBranchFile(ctx.reader, path),
    }).then((flow) => !flow.isOk() || flow.value.proofReady);
    ctx.proofReady.set(name, ready);
  }
  return ready;
}

/** Admit sent issues in queue order while slots remain; the slots left. */
async function admitQueue(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  queue: FactoryRunView[],
  slots: number,
  ctx: AdmissionContext,
): Promise<number> {
  let left = slots;
  for (const run of queue) {
    if (left <= 0) break;
    const admitted = await admitQueued(factory, repo, mode, run, ctx);
    // Another writer (a Retry, a take-over) took the last slot meanwhile.
    if (admitted === NO_FREE_SLOT) return 0;
    if (admitted) left--;
  }
  return left;
}

/**
 * Admit one sent issue when nothing holds it back; whether an agent started,
 * or `NO_FREE_SLOT` when the factory filled up since the pass counted.
 */
async function admitQueued(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  run: FactoryRunView,
  ctx: AdmissionContext,
): Promise<boolean | typeof NO_FREE_SLOT> {
  if (!runs || !deps) return false;
  if (await heldWithoutProofRules(factory, run, ctx)) return false;
  // The issue first: one closed since it was sent leaves the queue even while
  // something still blocks it.
  const issue = await openQueuedIssue(factory, run, ctx);
  if (!issue) return false;

  const reason = await blockedReason(ctx, run.issueNumber);
  await noteWaitReason(run, reason);
  if (reason) return false;

  // The capacity check is part of the write: the slots counted at the start of
  // the pass may have been taken during the GitHub reads above.
  const admitted = await runs.admit(factory.id, run.id);
  if (admitted.isOk() && admitted.value === NO_FREE_SLOT) return NO_FREE_SLOT;
  // Cancelled meanwhile (or another pass took it): not ours to start.
  if (admitted.isErr() || admitted.value !== 'admitted') return false;
  return startFlow(factory, repo, mode, issue, { ...run, state: 'queued', waitReason: null });
}

/** Store why a queued run waits (or that it no longer does), when that changed. */
async function noteWaitReason(run: FactoryRunView, reason: FactoryWaitReason | null) {
  if (!sameWaitReason(reason, run.waitReason)) await runs?.setWaitReason(run.id, reason);
}

/**
 * Whether the run's flow has no proof rules, so it could never merge: the run
 * stays queued, holding no slot, and says so until rules exist.
 */
async function heldWithoutProofRules(
  factory: WatchedFactory,
  run: FactoryRunView,
  ctx: AdmissionContext,
): Promise<boolean> {
  const flowName = run.flowName ?? factory.flowName;
  if (await flowProofReady(ctx, flowName)) return false;
  await reportBlocked(factory.id, proofNotConfigured(flowName));
  // The queue shows it on the run too; the next pass clears it once rules exist.
  await noteWaitReason(run, { kind: 'proof-not-configured', blockers: [] });
  return true;
}

/** A queued issue as GitHub has it, or null: unreadable now, or closed (then it leaves the queue). */
async function openQueuedIssue(
  factory: WatchedFactory,
  run: FactoryRunView,
  ctx: AdmissionContext,
): Promise<FactoryIssue | null> {
  const issue = await deps!.github.getIssue(ctx.reader, run.issueNumber);
  if (issue.isErr()) {
    log.warn('Issue factory could not read a queued issue', {
      namespace: 'factory',
      runId: run.id,
      issue: run.issueNumber,
      error: issue.error.message,
    });
    return null;
  }
  if (issue.value.state !== 'closed') return issue.value;
  await runs!.cancel(factory.id, run.id);
  log.info('Issue factory dropped a queued issue that was closed', {
    namespace: 'factory',
    runId: run.id,
    issue: run.issueNumber,
  });
  return null;
}

/** List the labelled issues and admit what fits (automatic mode). */
async function admitFromGithub(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  slots: number,
  ctx: AdmissionContext,
): Promise<void> {
  const issues = await deps!.github.listReadyIssues({
    repo,
    ownerId: factory.userId,
    projectId: factory.projectId,
    label: factory.label,
  });
  if (issues.isErr()) {
    log.warn('Issue factory could not list issues', {
      namespace: 'factory',
      factoryId: factory.id,
      repo,
      error: issues.error.message,
    });
    await reportBlocked(
      factory.id,
      `The issues of ${repo} could not be read: ${issues.error.message}`,
    );
    return;
  }
  await admitIssues(factory, repo, mode, issues.value, slots, ctx);
}

/**
 * The factory runs as its enabler, so it may only start threads while they
 * still hold `steer` on the project — re-checked every tick, since a role can
 * be lowered or a member removed after the factory was turned on. When they
 * lost it, the factory is turned off (and audited) instead of acting for them.
 */
async function enablerCanStillSteer(factory: WatchedFactory): Promise<boolean> {
  const check = deps?.checkAccess ?? defaultCheckAccess;
  if (await check(factory.userId, factory.projectId)) return true;
  await disableFactory(factory.id);
  unscheduleFactory(factory.id);
  await stopOpenRuns(factory);
  // The enabler sees why their factory stopped (track-funny-actions).
  await (deps?.activities ?? serverActivities).recordServerActivity(
    {
      kind: 'factory.disabled',
      userId: factory.userId,
      projectId: factory.projectId,
      title: 'Turned the issue factory off: you can no longer start threads in this project',
      input: { reason: 'access-lost' },
      origin: 'system',
    },
    { ok: true, effects: [{ effect: 'factory-disabled', target: factory.projectId }] },
  );
  audit({
    action: 'factory.disabled_access_lost',
    actorId: factory.userId,
    detail: `Factory for project ${factory.projectId} turned off: its enabler can no longer start threads there`,
    meta: { factoryId: factory.id, projectId: factory.projectId },
  });
  return false;
}

/** Stop every run of a factory that lost its enabler's access: nothing acts for them now. */
async function stopOpenRuns(factory: WatchedFactory): Promise<void> {
  if (!runs || !deps) return;
  const all = await runs.list(factory.id);
  if (all.isErr()) return;
  const open = all.value.filter((run) => !['merged', 'failed', 'stopped'].includes(run.state));
  for (const run of open) flows?.stop(run.id);
  await runs.stopMany(open.map((run) => run.id));
  await stopFactoryThreads(
    deps.ports,
    factory.userId,
    open.flatMap((run) => run.threadIds),
  );
}

async function defaultCheckAccess(userId: string, projectId: string): Promise<boolean> {
  return (await decideProjectAccess(projectRole, 'steer', projectId, userId)) === null;
}

/** Admit each labelled issue not already running nor blocked, while slots remain. */
async function admitIssues(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issues: FactoryIssue[],
  slots: number,
  ctx: AdmissionContext,
): Promise<void> {
  let free = slots;
  for (const issue of issues) {
    if (free <= 0) break;
    if (!(await isAdmissible(factory.id, issue.number))) continue;
    if (await blockedReason(ctx, issue.number)) continue;
    const started = await startImplement(factory, repo, mode, issue);
    // Another writer (a Retry, a take-over) took the last slot meanwhile.
    if (started === NO_FREE_SLOT) return;
    if (started) free--;
  }
}

/**
 * An issue may be admitted when it has no run in progress (or parked for a
 * person) and has failed fewer than `MAX_ATTEMPTS` times. A lookup that fails
 * skips the issue this tick rather than risk a second run.
 */
async function isAdmissible(factoryId: string, issueNumber: number): Promise<boolean> {
  if (!runs) return false;
  const existing = await runs.activeByIssue(factoryId, issueNumber);
  if (existing.isErr() || existing.value) return false;
  const failures = await runs.failedCount(factoryId, issueNumber);
  return failures.isOk() && failures.value < MAX_ATTEMPTS;
}

/**
 * Close the parked runs whose pull request a person merged (or closed) outside
 * the factory, e.g. after the run waited for them at a CI check that could not
 * run: otherwise they stay "waiting for you" and hold their issue. Works for any
 * flow: a run with no recorded pull request (its flow has no `create_pr` step)
 * is looked up by its branch. Best effort: a pull request that cannot be read
 * now is looked at again on the next tick.
 */
async function reconcileParked(factory: WatchedFactory, repo: string): Promise<void> {
  if (!runs) return;
  const parked = await runs.awaitingPullRequest(factory.id);
  if (parked.isErr()) return;
  for (const run of parked.value) await reconcileRun(factory, repo, run);
}

/** A parked run whose pull request head needs its proof on GitHub. */
interface ParkedProofTarget {
  run: FactoryRunView;
  threadId: string;
  pr: { repo: string; number: number; userId: string; projectId: string };
  /** The pull request's head now. */
  sha: string;
  config: RegressionProofOpts;
  testRequired: boolean;
}

/** The flow's proof rules of a run, read from the default branch; null without rules. */
async function proofConfigOf(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
): Promise<RegressionProofOpts | null> {
  if (!deps) return null;
  const github = deps.github;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  const flow = await loadFactoryFlow(run.flowName ?? factory.flowName, {
    readDefaultBranchFile: (path) => github.readDefaultBranchFile(reader, path),
  });
  const config = flow.isOk() ? flow.value.regressionProof : undefined;
  return config && config.rules.length > 0 ? config : null;
}

/**
 * What to prove or publish for a run waiting on GitHub's auto-merge: its pull
 * request head when that is not the proved commit, or the proved commit when
 * its check never reached GitHub. Null when there is nothing to do, or
 * something could not be read (the next tick looks again).
 */
async function parkedProofTarget(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
  number: number,
): Promise<ParkedProofTarget | null> {
  const threadId = run.threadIds[0];
  const proved = run.regressionProof;
  if (!deps || !threadId || !proved) return null;
  const pr = { repo, number, userId: factory.userId, projectId: factory.projectId };
  const head = await deps.github.pullRequests.pullHead(pr);
  // Only while GitHub's auto-merge waits on it; an unread head is looked at again.
  const sha = head.isOk() && head.value.autoMerge ? head.value.sha : null;
  if (!sha || (sha === proved.headSha && proved.checkPublished !== false)) return null;
  const config = await proofConfigOf(factory, repo, run);
  if (!config) return null;
  const testRequired = await parkedTestRequired(factory, repo, run, config);
  return testRequired === null ? null : { run, threadId, pr, sha, config, testRequired };
}

/**
 * Whether a parked run's issue needs a regression test, which decides its
 * check's conclusion. Null when the issue cannot be read: nothing is published
 * then (an unread label must not exempt it).
 */
async function parkedTestRequired(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
  config: RegressionProofOpts,
): Promise<boolean | null> {
  if (!deps) return null;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  const issue = await deps.github.getIssue(reader, run.issueNumber);
  if (issue.isOk()) return regressionTestRequired(config, issue.value.labels ?? []);
  log.warn("Issue factory could not read a parked run's issue, its new head is not proved yet", {
    namespace: 'factory',
    runId: run.id,
    error: issue.error.message,
  });
  return null;
}

/** Prove the target's head on the runner; null when there is no verdict of that commit. */
async function proveParkedHead(
  target: ParkedProofTarget,
  proofDeps: FactoryProofDeps,
  signal: AbortSignal,
): Promise<RegressionProofRecord | null> {
  const { run, sha } = target;
  // A head this checkout lacks was pushed by someone else: fetched and run only in a sandbox.
  const fetchHead = await (deps?.runsPushedCommits ?? runsPushedCommits)(target.threadId);
  const proof = await proveOnRunner(
    proofDeps,
    target.threadId,
    target.config,
    signal,
    sha,
    fetchHead,
  );
  // A verdict of another commit (or of none) says nothing about this head.
  const why =
    proof.kind === 'unavailable'
      ? proof.why
      : proof.result.headSha === sha
        ? null
        : `the runner proved ${proof.result.headSha || 'no commit'}`;
  if (proof.kind === 'unavailable' || why) {
    log.warn("Issue factory could not prove a parked run's new head", {
      namespace: 'factory',
      runId: run.id,
      headSha: sha,
      error: why,
    });
    return null;
  }
  return proofRecordOf(proof.result);
}

/**
 * Record the proof of the target's head and publish its check. The record is
 * stored first, marked unpublished, and only while the run is still parked;
 * a publish that fails is tried again on a later tick without proving again.
 */
async function settleParkedProof(
  target: ParkedProofTarget,
  proofDeps: FactoryProofDeps,
  repository: ReturnType<typeof createFactoryRunsRepository>,
  signal: AbortSignal,
): Promise<void> {
  const { run, sha } = target;
  const held = run.regressionProof?.headSha === sha ? run.regressionProof : null;
  const proved = held ?? (await proveParkedHead(target, proofDeps, signal));
  if (!proved) return;
  const reason = held ? run.failureReason : parkedFailureReason(target, proved);
  await publishParkedProof(target, repository, proved, reason);
}

/** Why a parked run cannot merge after `proved`, the proof of its new head; null when it can. */
function parkedFailureReason(target: ParkedProofTarget, proved: RegressionProofRecord) {
  if (proofAllowsMerge(proved, target.testRequired)) return null;
  return `Regression proof failed on the new head ${target.sha}: ${proved.finding ?? 'no regression test'}`;
}

/** Store the proof marked unpublished, publish its check, then mark it published. */
async function publishParkedProof(
  target: ParkedProofTarget,
  repository: ReturnType<typeof createFactoryRunsRepository>,
  proved: RegressionProofRecord,
  reason: string | null,
): Promise<void> {
  if (!deps) return;
  const { run } = target;
  const stored = await repository.recordParkedProof(
    run.id,
    { ...proved, checkPublished: false },
    reason,
  );
  // Retried or taken over meanwhile (or not stored): its check is not this watcher's to publish.
  if (stored.isErr() || !stored.value) return;
  const published = await deps.github.pullRequests.publishProofCheck(
    target.pr,
    proofCheckOf(proved, target.testRequired),
  );
  if (published.isErr()) {
    log.warn('Issue factory could not publish the regression proof check', {
      namespace: 'factory',
      runId: run.id,
      headSha: target.sha,
      error: published.error.message,
    });
    return;
  }
  await repository.recordParkedProof(run.id, { ...proved, checkPublished: true }, reason);
}

/**
 * A run waiting on GitHub's auto-merge whose pull request head is no longer
 * the proved commit: prove the new head and publish its check, in the
 * background (one at a time per run). GitHub does not merge before that check
 * passes; a failing proof leaves a failing check and the finding on the run.
 */
async function reproveMovedHead(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
  number: number,
): Promise<void> {
  if (!runs || !proofs || reproving.has(run.id)) return;
  const repository = runs;
  const proofsFor = proofs;
  const target = await parkedProofTarget(factory, repo, run, number);
  if (!target || reproving.has(run.id)) return;
  const controller = new AbortController();
  reproving.set(run.id, controller);
  const proofDeps = proofsFor(factory.userId, target.threadId);
  void settleParkedProof(target, proofDeps, repository, controller.signal)
    .catch((error: unknown) => {
      log.error("Issue factory failed while proving a parked run's new head", {
        namespace: 'factory',
        runId: run.id,
        headSha: target.sha,
        error: String(error),
      });
    })
    .finally(() => reproving.delete(run.id));
}

/** The run's pull request number: the recorded one, else the one on its branch (then recorded). */
async function pullRequestOf(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
): Promise<number | null> {
  const recorded = prNumberOf(run.prUrl);
  if (recorded !== null || !runs || !deps) return recorded;
  const found = await deps.github.findPullRequest(
    { repo, ownerId: factory.userId, projectId: factory.projectId },
    factoryRunBranch(run),
    'all',
  );
  if (found.isErr() || !found.value) return null;
  const saved = await runs.recordParkedPr(run.id, found.value.url);
  return saved.isOk() && saved.value ? found.value.number : null;
}

/** Close one parked run when its pull request is merged or closed. */
async function reconcileRun(
  factory: WatchedFactory,
  repo: string,
  run: FactoryRunView,
): Promise<void> {
  const number = await pullRequestOf(factory, repo, run);
  if (number === null || !runs || !deps) return;
  const pr = await deps.github.pullRequests.prState({
    repo,
    number,
    userId: factory.userId,
    projectId: factory.projectId,
  });
  if (pr.isErr()) return;
  if (pr.value === 'open') {
    await reproveMovedHead(factory, repo, run, number);
    return;
  }
  const closed = await runs.closeParked(run.id, pr.value);
  if (closed.isErr() || !closed.value) return;
  log.info('Issue factory run closed: its pull request was finished outside the factory', {
    namespace: 'factory',
    factoryId: factory.id,
    runId: run.id,
    issue: run.issueNumber,
    pullRequest: pr.value,
  });
  if (pr.value === 'merged') await cleanupMergedFor(deps, factory.userId, run.threadIds);
}

/** Remove a merged run's worktrees: the test override, else on the enabler's runner. */
function cleanupMergedFor(
  d: FactoryWatcherDeps,
  userId: string,
  threadIds: string[],
): Promise<void> {
  return d.cleanupMerged
    ? d.cleanupMerged(userId, threadIds)
    : cleanupFactoryWorktrees(d.ports, userId, threadIds, d.browserEvents);
}

/**
 * Resume every run in flight whose flow is not running in this process — the
 * server restarted, or an earlier attempt to resume it stopped. The provider
 * replays the agent steps already recorded, so nothing starts twice.
 */
async function resumeRuns(factory: WatchedFactory, repo: string, mode: LaunchMode): Promise<void> {
  if (!runs || !flows || !deps) return;
  const inFlight = await runs.inFlight(factory.id);
  if (inFlight.isErr()) return;
  for (const run of inFlight.value) {
    if (flows.isActive(run.id)) continue;
    const issue = await deps.github.getIssue(
      { repo, ownerId: factory.userId, projectId: factory.projectId },
      run.issueNumber,
    );
    if (issue.isErr()) {
      log.warn('Issue factory run could not be resumed: its issue is unreadable', {
        namespace: 'factory',
        runId: run.id,
        issue: run.issueNumber,
        error: issue.error.message,
      });
      continue;
    }
    // Not awaited: a resumed flow may wait on a thread or on CI for hours, and
    // the tick must stay free (`isActive` keeps a second start out).
    void flows.start({ factory, repo, mode, issue: issue.value, run });
  }
}

/**
 * Record a run for an issue and start its flow; whether an agent started, or
 * `NO_FREE_SLOT` when the factory filled up since the pass counted.
 */
async function startImplement(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
): Promise<boolean | typeof NO_FREE_SLOT> {
  if (!runs || !flows) return false;

  // Record the run before launching, so the issue is taken while the launch is
  // in flight: no later tick (or reschedule) can admit it a second time. The
  // capacity check is part of the write.
  const run = await runs.startInFlight({
    factoryId: factory.id,
    issueNumber: issue.number,
    source: 'label',
    flowName: factory.flowName,
  });
  if (run.isErr()) {
    log.error('Issue factory run could not be recorded', {
      namespace: 'factory',
      factoryId: factory.id,
      issue: issue.number,
      error: run.error.message,
    });
    return false;
  }
  if (run.value === NO_FREE_SLOT) return NO_FREE_SLOT;
  return startFlow(factory, repo, mode, issue, run.value);
}

/** Start an admitted run's flow; whether its first agent started. */
async function startFlow(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
  run: FactoryRunView,
): Promise<boolean> {
  if (!flows) return false;
  // Wait for the first agent to be recorded so a launch that fails frees its
  // slot this tick, but not longer than ADMIT_WAIT_MS: a flow that does not
  // start with an agent (or a slow sandbox) must not hold the tick.
  const timer = new AbortController();
  const started = await Promise.race([
    flows.start({ factory, repo, mode, issue, run }),
    interruptibleSleep(ADMIT_WAIT_MS, timer.signal).then(
      () => 'started' as const,
      () => 'started' as const,
    ),
  ]).finally(() => timer.abort());
  log.info('Issue factory run admitted', {
    namespace: 'factory',
    factoryId: factory.id,
    runId: run.id,
    issue: issue.number,
    source: run.source,
    mode,
    started,
  });
  return started === 'started';
}

/** The thread modes phase 2 can launch. */
type LaunchMode = FactoryThreadMode;

/**
 * The thread mode for the enabler's runtime, or `null` for a sandbox runtime
 * when this server cannot launch sandbox threads (`launchSandbox` not wired):
 * the spec forbids falling back to a different runtime.
 *
 * A `local` runtime runs factory threads in a worktree, never in the
 * enabler's own checkout: an unattended agent there stashes their
 * uncommitted work, switches its branch under them, and restarts a dev
 * runner watching those files.
 */
async function resolveMode(userId: string, projectId: string): Promise<LaunchMode | null> {
  const runtime = await (deps?.resolveRuntime ?? defaultResolveRuntime)(userId, projectId);
  if (runtime === 'local') return 'worktree';
  return runtime === 'sandbox' && !deps?.launchSandbox ? null : runtime;
}

/**
 * Start a run's agent thread where the enabler's runtime says: a sandbox thread
 * on their own sandbox connection, or a local / worktree thread on their runner.
 */
function launchFor(d: FactoryWatcherDeps) {
  return async (input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>> => {
    const { mode, ...body } = input.body;
    if (mode === 'sandbox' && d.launchSandbox) {
      return d.launchSandbox(input.userId, { ...body, source: 'factory' });
    }
    return (d.launch ?? startThreadOnRunner)(input, d.ports);
  };
}
