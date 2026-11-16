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

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { projectSandboxSettings } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { startThreadOnRunner, type RunnerPorts } from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import { createFactoryRunsRepository } from './factory-runs.js';
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

const jobs = new Map<string, FactoryPoll>();
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
  return fire(id).catch((error: unknown) => {
    log.error('Issue factory tick failed', {
      namespace: 'factory',
      factoryId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function fire(id: string): Promise<void> {
  if (!deps || !runs) return;
  // Re-read so a disable or an edit that raced the tick is honored.
  const factory = await getEnabledFactory(id);
  if (!factory) {
    unscheduleFactory(id);
    return;
  }
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
    const existing = await runs.activeByIssue(factory.id, issue.number);
    if (existing.isErr()) continue;
    if (existing.value) continue; // already running for this issue
    const started = await startImplement(factory, repo, mode, issue);
    if (started) slots--;
  }
}

/** Start one implement thread for an issue and record its run. */
async function startImplement(
  factory: EnabledFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue,
): Promise<boolean> {
  if (!deps || !runs) return false;
  const title = `[Factory] #${issue.number} ${issue.title}`.slice(0, 200);
  const prompt = buildImplementPrompt(repo, issue);

  const launched = await (deps.launch ?? startThreadOnRunner)(
    {
      userId: factory.userId,
      body: {
        projectId: factory.projectId,
        title,
        mode,
        source: 'factory',
        prompt,
      },
    },
    deps.ports,
  );

  const threadId = launched.isOk() ? launched.value.threadId : undefined;
  if (launched.isErr() || !threadId) {
    log.warn('Issue factory run could not start', {
      namespace: 'factory',
      factoryId: factory.id,
      issue: issue.number,
      reason: launched.isErr() ? launched.error.message : 'runner returned no thread id',
    });
    return false;
  }

  const run = await runs.start({
    factoryId: factory.id,
    issueNumber: issue.number,
    threadIds: [threadId],
    currentStep: 'implement',
  });
  if (run.isErr()) {
    log.error('Issue factory run started but could not be recorded', {
      namespace: 'factory',
      factoryId: factory.id,
      issue: issue.number,
      threadId,
      error: run.error.message,
    });
    return true;
  }
  await runs.update(run.value.id, { state: 'working' });
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
