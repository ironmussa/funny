/**
 * Server-owned issue-factory watcher (change issue-factory, phase 2; flows in
 * factory-flow-execution).
 *
 * Holds one polling job per enabled factory and, on each tick, resolves the
 * project's GitHub repo, lists its open labelled issues, admits the ones not
 * already running and under the concurrency cap, and runs the factory's flow
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

import { and, eq } from 'drizzle-orm';
import type { Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { projectSandboxSettings } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';
import { startThreadOnRunner, type RunnerPorts } from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import {
  createFactoryFlowRuns,
  type FactoryRunJob,
  type WaitingNotice,
} from './factory-flow-runs.js';
import type { FactoryFlow, FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import { createFactoryRunsRepository, IN_FLIGHT_STATES } from './factory-runs.js';
import {
  disableFactory,
  getWatchedFactory,
  listWatchedFactories,
  type WatchedFactory,
} from './factory-settings.js';
import { sendFactoryFollowUp, stopFactoryThreads } from './factory-thread-requests.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

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
  /** Runtime resolver override for tests; defaults to the enabler's `project_sandbox_settings`. */
  resolveRuntime?: (userId: string, projectId: string) => Promise<ThreadRuntimeMode>;
  /** Thread wait override for tests; defaults to the DB status plus the terminal signal. */
  waitThread?: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /** Follow-up override for tests; defaults to a message on the thread's runner, as the enabler. */
  followUp?: (userId: string, threadId: string, content: string) => Promise<Result<void, string>>;
  /** Notification override for tests; defaults to Web Push. */
  notify?: (userId: string, message: WaitingNotice) => Promise<unknown>;
  /** Flow loader override for tests; defaults to the default branch, then the built-ins. */
  loadFlow?: (job: FactoryRunJob) => Promise<Result<FactoryFlow, FactoryFlowError>>;
}

/** How often each factory polls GitHub while the server is up. */
const POLL_INTERVAL_MS = 60 * 1000;

/** The production poll. `unref` keeps the timer from holding the process open. */
const startIntervalPoll: CreatePoll = (onTick) => {
  const timer = setInterval(() => void onTick(), POLL_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

/** Runs of an issue that may fail before the factory stops re-admitting it. */
export const MAX_ATTEMPTS = 3;

const jobs = new Map<string, FactoryPoll>();
/** Factories with a tick in progress: a slow tick is never overlapped by the next one. */
const busy = new Set<string>();
let deps: FactoryWatcherDeps | null = null;
let runs: ReturnType<typeof createFactoryRunsRepository> | null = null;
let flows: ReturnType<typeof createFactoryFlowRuns> | null = null;

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
  flows = createFactoryFlowRuns({
    runs,
    github: d.github,
    launch: (input) => (d.launch ?? startThreadOnRunner)(input, d.ports),
    waitThread: d.waitThread,
    loadFlow: d.loadFlow,
    notify: d.notify,
    followUp:
      d.followUp ??
      ((userId, threadId, content) => sendFactoryFollowUp(d.ports, userId, threadId, content)),
  });
  for (const factory of await listWatchedFactories([...IN_FLIGHT_STATES])) schedule(factory);
  log.info('Issue factory watcher started', { namespace: 'factory', jobs: jobs.size });
}

export function stopFactoryWatcher(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  busy.clear();
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
  await resumeRuns(factory, target.repo, target.mode);
  // A paused factory finishes its runs but admits nothing new.
  if (factory.enabled) await admitFromGithub(factory, target.repo, target.mode);
}

/** An enabled factory, or a paused one with runs still in flight. */
async function hasWork(factory: WatchedFactory): Promise<boolean> {
  if (factory.enabled) return true;
  const active = await runs!.countActive(factory.id);
  return active.isErr() || active.value > 0;
}

/**
 * Where the factory's runs execute: the enabler's runtime and the project's
 * repository, or null (logged) when it cannot run now. A sandbox runtime is
 * NOT downgraded to local (issue text is untrusted input, and the enabler
 * chose isolation): the factory waits until sandbox launches are supported.
 */
async function resolveTarget(
  factory: WatchedFactory,
): Promise<{ mode: LaunchMode; repo: string } | null> {
  const mode = await resolveMode(factory.userId, factory.projectId);
  if (!mode) {
    log.info('Issue factory tick skipped: sandbox runtime is not supported yet', {
      namespace: 'factory',
      factoryId: factory.id,
      projectId: factory.projectId,
    });
    return null;
  }
  const repo = await deps!.github.resolveRepo(factory.userId, factory.projectId);
  if (!repo) {
    log.info('Issue factory tick skipped: repository not resolvable', {
      namespace: 'factory',
      factoryId: factory.id,
      projectId: factory.projectId,
    });
    return null;
  }
  return { mode, repo };
}

/** List the labelled issues and admit what fits. */
async function admitFromGithub(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
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
    return;
  }
  await admitIssues(factory, repo, mode, issues.value);
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

/** Admit each issue not already running, up to the concurrency cap. */
async function admitIssues(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issues: FactoryIssue[],
): Promise<void> {
  if (!runs) return;
  const activeResult = await runs.countActive(factory.id);
  if (activeResult.isErr()) {
    log.warn('Issue factory could not read active runs', {
      namespace: 'factory',
      factoryId: factory.id,
      error: activeResult.error.message,
    });
    return;
  }
  let slots = factory.maxConcurrent - activeResult.value;

  for (const issue of issues) {
    if (slots <= 0) break;
    if (!(await isAdmissible(factory.id, issue.number))) continue;
    const started = await startImplement(factory, repo, mode, issue);
    if (started) slots--;
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
    await flows.start({ factory, repo, mode, issue: issue.value, run });
  }
}

/** Record a run for an issue and start its flow; whether an agent started. */
async function startImplement(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
): Promise<boolean> {
  if (!runs || !flows) return false;

  // Record the run before launching, so the issue is taken while the launch is
  // in flight: no later tick (or reschedule) can admit it a second time.
  const run = await runs.start({ factoryId: factory.id, issueNumber: issue.number });
  if (run.isErr()) {
    log.error('Issue factory run could not be recorded', {
      namespace: 'factory',
      factoryId: factory.id,
      issue: issue.number,
      error: run.error.message,
    });
    return false;
  }

  const started = await flows.start({ factory, repo, mode, issue, run: run.value });
  log.info('Issue factory run admitted', {
    namespace: 'factory',
    factoryId: factory.id,
    runId: run.value.id,
    issue: issue.number,
    mode,
    started,
  });
  return started === 'started';
}

/** The thread modes phase 2 can launch. */
type LaunchMode = 'local' | 'worktree';

/**
 * The thread mode for the enabler's runtime, or `null` for a sandbox runtime:
 * the sandbox launch path is phase 3+, and the spec forbids falling back to a
 * different runtime.
 */
async function resolveMode(userId: string, projectId: string): Promise<LaunchMode | null> {
  const runtime = await (deps?.resolveRuntime ?? defaultResolveRuntime)(userId, projectId);
  return runtime === 'sandbox' ? null : runtime;
}
