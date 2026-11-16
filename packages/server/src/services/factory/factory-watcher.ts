/**
 * Server-owned issue-factory watcher (change issue-factory, phase 2).
 *
 * Holds one polling job per enabled factory and, on each tick, resolves the
 * project's GitHub repo, lists its open labelled issues, admits the ones not
 * already running and under the concurrency cap, and starts an "implement"
 * thread for each on the ENABLING user's runner through `startThreadOnRunner` —
 * the same path interactive threads take, so runner isolation and the
 * project ↔ runner binding apply unchanged. Each admitted issue becomes a
 * `factory_runs` row, completed by `onFactoryThreadTerminal` when the runner
 * persists the thread's terminal status.
 *
 * Single-instance assumption (shared with the automation scheduler): every
 * server process that calls `startFactoryWatcher` polls every factory.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { projectSandboxSettings, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { startThreadOnRunner, type RunnerPorts } from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import { onFactoryThreadTerminal } from './factory-runs-completion.js';
import { createFactoryRunsRepository, type FactoryRunView } from './factory-runs.js';
import {
  getEnabledFactory,
  listEnabledFactories,
  type EnabledFactory,
} from './factory-settings.js';

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
  /** Runtime resolver override for tests; defaults to the enabler's `project_sandbox_settings`. */
  resolveRuntime?: (userId: string, projectId: string) => Promise<ThreadRuntimeMode>;
  now?: () => Date;
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

/** A run still `queued` this long after admission lost its launch (e.g. a crash). */
const QUEUED_STALE_MS = 10 * 60 * 1000;

const TERMINAL_THREAD_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

const jobs = new Map<string, FactoryPoll>();
/** Factories with a tick in progress: a slow tick is never overlapped by the next one. */
const busy = new Set<string>();
let deps: FactoryWatcherDeps | null = null;
let runs: ReturnType<typeof createFactoryRunsRepository> | null = null;

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
  for (const factory of await listEnabledFactories()) schedule(factory);
  log.info('Issue factory watcher started', { namespace: 'factory', jobs: jobs.size });
}

export function stopFactoryWatcher(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  busy.clear();
  deps = null;
  runs = null;
}

/** Re-read a factory and (re)schedule it — call after a settings change. */
export async function rescheduleFactory(id: string): Promise<void> {
  unscheduleFactory(id);
  if (!deps) return;
  const factory = await getEnabledFactory(id);
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

function schedule(factory: EnabledFactory): void {
  if (!deps) return;
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
  const factory = await getEnabledFactory(id);
  if (!factory) {
    unscheduleFactory(id);
    return;
  }
  await reconcile(factory.id);
  // The enabler's runtime decides where the agent runs. Phase 2 launches only
  // local and worktree threads; a sandbox runtime is NOT downgraded to local
  // (issue text is untrusted input, and the enabler chose isolation), so the
  // factory waits until sandbox launches are supported.
  const mode = await resolveMode(factory.userId, factory.projectId);
  if (!mode) {
    log.info('Issue factory tick skipped: sandbox runtime is not supported yet', {
      namespace: 'factory',
      factoryId: id,
      projectId: factory.projectId,
    });
    return;
  }

  const repo = await deps.github.resolveRepo(factory.userId, factory.projectId);
  if (!repo) {
    log.info('Issue factory tick skipped: repository not resolvable', {
      namespace: 'factory',
      factoryId: id,
      projectId: factory.projectId,
    });
    return;
  }

  const issues = await deps.github.listReadyIssues({
    repo,
    ownerId: factory.userId,
    projectId: factory.projectId,
    label: factory.label,
  });
  if (issues.isErr()) {
    log.warn('Issue factory could not list issues', {
      namespace: 'factory',
      factoryId: id,
      repo,
      error: issues.error.message,
    });
    return;
  }

  await admitIssues(factory, repo, mode, issues.value);
}

/** Admit each issue not already running, up to the concurrency cap. */
async function admitIssues(
  factory: EnabledFactory,
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
 * Settle in-flight runs from the server's own records, so a lost signal never
 * holds a slot forever: a `working` run whose thread already finished is
 * completed (its terminal event may have raced the launch, or arrived while the
 * server was down), one whose thread is gone fails, and a `queued` run whose
 * launch never finished fails once stale.
 */
async function reconcile(factoryId: string): Promise<void> {
  if (!runs) return;
  const inFlight = await runs.inFlight(factoryId);
  if (inFlight.isErr()) return;
  const now = (deps?.now ?? (() => new Date()))().getTime();
  for (const run of inFlight.value) {
    if (run.state === 'queued') {
      if (now - Date.parse(run.startedAt) > QUEUED_STALE_MS) {
        await runs.advance(run.id, 'queued', { state: 'failed', currentStep: null });
      }
    } else if (run.state === 'working') {
      await settleWorkingRun(run);
    }
  }
}

async function settleWorkingRun(run: FactoryRunView): Promise<void> {
  if (!runs || run.threadIds.length === 0) return;
  const rows = await db
    .select({ id: threads.id, status: threads.status })
    .from(threads)
    .where(inArray(threads.id, run.threadIds));
  if (rows.length === 0) {
    await runs.advance(run.id, 'working', { state: 'failed', currentStep: null });
    return;
  }
  const finished = rows.find((row) => TERMINAL_THREAD_STATUSES.has(row.status));
  if (finished) await onFactoryThreadTerminal(finished.id, finished.status);
}

/** Start one implement thread for an issue and record its run. */
async function startImplement(
  factory: EnabledFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
): Promise<boolean> {
  if (!runs) return false;

  // Record the run before launching, so the issue is taken while the launch is
  // in flight: no later tick (or reschedule) can admit it a second time.
  const run = await runs.start({
    factoryId: factory.id,
    issueNumber: issue.number,
    currentStep: 'implement',
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

  const threadId = await launchImplement(factory, repo, mode, issue);
  if (!threadId) {
    // No agent ran, so this is not an attempt: drop the run and let a later
    // tick try again (e.g. once the enabler's runner is back online).
    await runs.remove(run.value.id);
    return false;
  }

  const recorded = await runs.advance(run.value.id, 'queued', {
    state: 'working',
    threadIds: [threadId],
  });
  if (recorded.isErr()) {
    // The thread runs but its run stays `queued`; reconcile fails it once stale.
    log.error('Issue factory run started but its thread could not be recorded', {
      namespace: 'factory',
      factoryId: factory.id,
      issue: issue.number,
      threadId,
      error: recorded.error.message,
    });
    return true;
  }
  log.info('Issue factory run started', {
    namespace: 'factory',
    factoryId: factory.id,
    runId: run.value.id,
    issue: issue.number,
    threadId,
    mode,
  });
  return true;
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

/** Start the implement thread on the enabler's runner; its id, or null when it did not start. */
async function launchImplement(
  factory: EnabledFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
): Promise<string | null> {
  if (!deps) return null;
  const launched = await (deps.launch ?? startThreadOnRunner)(
    {
      userId: factory.userId,
      body: {
        projectId: factory.projectId,
        title: `[Factory] #${issue.number} ${issue.title}`.slice(0, 200),
        mode,
        source: 'factory',
        prompt: buildImplementPrompt(repo, issue),
      },
    },
    deps.ports,
  );
  const threadId = launched.isOk() ? launched.value.threadId : undefined;
  if (threadId) return threadId;
  log.warn('Issue factory run could not start', {
    namespace: 'factory',
    factoryId: factory.id,
    issue: issue.number,
    reason: launched.isErr() ? launched.error.message : 'runner returned no thread id',
  });
  return null;
}

function buildImplementPrompt(repo: string, issue: FactoryIssue): string {
  return [
    `You are implementing GitHub issue #${issue.number} of ${repo}.`,
    '',
    `Title: ${issue.title}`,
    `Issue: ${issue.url}`,
    '',
    'Read the issue, implement the change it asks for on a new branch, run the',
    "project's tests, commit, and open a pull request. Follow the repository's",
    'conventions.',
  ].join('\n');
}
