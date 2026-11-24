/**
 * Server-owned issue-factory watcher (change issue-factory, phase 2; flows in
 * factory-flow-execution).
 *
 * Holds one polling job per enabled factory and, on each tick, resolves the
 * project's GitHub repo, queues its open labelled issues in automatic mode
 * (behind the issues sent to the factory), then admits from that queue, in
 * order, the issues not blocked by an unfinished issue
 * (`factory-dependencies.ts`), as many as the concurrency cap leaves free, all
 * started together — and runs each run's flow as the ENABLING user (`factory-flow-runs.ts`): its agent steps are
 * threads started through `startThreadOnRunner` — the same path interactive
 * threads take, so runner isolation and the project ↔ runner binding apply
 * unchanged. Each admitted issue becomes a `factory_runs` row; a run in flight
 * whose flow is not running in this process (a restart) is resumed by the
 * next tick.
 *
 * Single-instance assumption: every
 * server process that calls `startFactoryWatcher` polls every factory.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { FactoryTrigger } from '@funny/shared/contracts/factory';
import { contractOf } from '@funny/shared/contracts/factory';
import { and, eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { projectSandboxSettings, threads } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';
import { serverActivities } from '../activities/server-activities.js';
import {
  startThreadOnRunner,
  type RunnerPorts,
  type StartedThread,
  type StartThreadError,
  type StartThreadInput,
} from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import { sendPush } from '../web-push.js';
import type { FactoryThreadMode } from './factory-action-provider.js';
import { integrateEarly, integrateStacked } from './factory-early-watch.js';
import { createFactoryFlowRuns } from './factory-flow-runs.js';
import { type FactoryGithubPort } from './factory-github.js';
import { createFactoryIncidentsRepository } from './factory-incidents.js';
import { prNumberOf } from './factory-pull-requests.js';
import { createFactoryRunsRepository, IN_FLIGHT_STATES, threadsOf } from './factory-runs.js';
import { createFactorySentinel } from './factory-sentinel.js';
import {
  disableFactory,
  getWatchedFactory,
  listWatchedFactories,
  type WatchedFactory,
} from './factory-settings.js';
import {
  type BrowserEventsPort,
  cleanupFactoryWorktrees,
  cancelRegressionProofOnRunner,
  pollRegressionProofOnRunner,
  sendFactoryFollowUp,
  cancelFactoryStepOnRunner,
  pollFactoryStepOnRunner,
  startFactoryStepOnRunner,
  startRegressionProofOnRunner,
  stopFactoryThreads,
} from './factory-thread-requests.js';
import { finishRoleThreadStage } from './factory-thread-stage.js';
import { lastThreadMessage } from './factory-thread-waits.js';
import { issueChangedSince } from './factory-triage.js';
import {
  createFactoryTriggersRepository,
  MISSED_OCCURRENCE_MS,
  type FactoryTriggersRepository,
} from './factory-triggers.js';
import { admitWork } from './factory-watcher-admission.js';
import { abortReproving, cleanupMergedFor, reconcileParked } from './factory-watcher-parked.js';
import {
  forgetBlockedReasons,
  reportBlocked,
  watcher,
  type CreatePoll,
  type FactoryPoll,
  type FactoryWatcherDeps,
} from './factory-watcher-state.js';

export { MAX_ATTEMPTS, pathsHeld, stackTarget } from './factory-watcher-admission.js';
export type { CreatePoll } from './factory-watcher-state.js';

/** How often each factory polls GitHub while the server is up. */
const POLL_INTERVAL_MS = 60 * 1000;

/** The production poll. `unref` keeps the timer from holding the process open. */
const startIntervalPoll: CreatePoll = (onTick) => {
  const timer = setInterval(() => void onTick(), POLL_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

const jobs = new Map<string, FactoryPoll>();
/** Factories with a tick in progress: a slow tick is never overlapped by the next one. */
const busy = new Set<string>();

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
  watcher.deps = d;
  watcher.runs = d.runs ?? createFactoryRunsRepository();
  watcher.proofs =
    d.proof ??
    ((userId, _threadId) => ({
      startProof: (tid, body) => startRegressionProofOnRunner(d.ports, userId, tid, body),
      pollProof: (tid, proofId) => pollRegressionProofOnRunner(d.ports, userId, tid, proofId),
      cancelProof: (tid, proofId) => cancelRegressionProofOnRunner(d.ports, userId, tid, proofId),
    }));
  const steps =
    d.steps ??
    ((userId: string) => ({
      startStep: (tid: string, body: Record<string, unknown>) =>
        startFactoryStepOnRunner(d.ports, userId, tid, body),
      pollStep: (tid: string, stepId: string) =>
        pollFactoryStepOnRunner(d.ports, userId, tid, stepId),
      cancelStep: (tid: string, stepId: string) =>
        cancelFactoryStepOnRunner(d.ports, userId, tid, stepId),
    }));
  watcher.flows = createFactoryFlowRuns({
    steps,
    runs: watcher.runs,
    github: d.github,
    launch: launchFor(d),
    waitThread: d.waitThread,
    lastThreadMessage: d.lastThreadMessage,
    loadFlow: d.loadFlow,
    notify: d.notify,
    gate: d.gate,
    proof: watcher.proofs,
    reportBlocked: (factoryId, reason) => reportBlocked(factoryId, reason),
    stopThreads: (userId, threadIds) => stopFactoryThreads(d.ports, userId, threadIds),
    cleanupMerged: (userId, threadIds) => cleanupMergedFor(d, userId, threadIds),
    cleanupUnchanged: (userId, threadIds) =>
      d.cleanupUnchanged
        ? d.cleanupUnchanged(userId, threadIds)
        : cleanupFactoryWorktrees(d.ports, userId, threadIds, d.browserEvents, {
            keepUnsaved: true,
          }),
    followUp:
      d.followUp ??
      ((userId, threadId, content, expectedBranch, options) =>
        sendFactoryFollowUp(d.ports, userId, threadId, content, expectedBranch, options)),
  });
  for (const factory of await listWatchedFactories([...IN_FLIGHT_STATES])) schedule(factory);
  log.info('Issue factory watcher started', { namespace: 'factory', jobs: jobs.size });
}

export function stopFactoryWatcher(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  busy.clear();
  forgetBlockedReasons();
  abortReproving();
  watcher.proofs = null;
  watcher.flows?.stopAll();
  watcher.flows = null;
  watcher.deps = null;
  watcher.runs = null;
}

/** Re-read a factory and (re)schedule it — call after a settings change. */
export async function rescheduleFactory(id: string): Promise<void> {
  unscheduleFactory(id);
  if (!watcher.deps) return;
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
  if (!watcher.deps) return;
  if (!jobs.has(id)) {
    const factory = await getWatchedFactory(id);
    if (!factory) return;
    schedule(factory);
  }
  await tick(id);
}

/** Stop driving a run's flow in this process (the run was stopped). */
export function stopFactoryFlow(runId: string): void {
  watcher.flows?.stop(runId);
}

/** The runner ports the watcher acts through, while it runs. */
export function factoryRunnerPorts(): RunnerPorts | null {
  return watcher.deps?.ports ?? null;
}

/** Where the watcher tells the enabler's browsers about changed threads, while it runs. */
export function factoryBrowserEvents(): BrowserEventsPort | undefined {
  return watcher.deps?.browserEvents;
}

function schedule(factory: WatchedFactory): void {
  if (!watcher.deps || jobs.has(factory.id)) return;
  const job = (watcher.deps.createPoll ?? startIntervalPoll)(() => tick(factory.id));
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
  if (!watcher.deps || !watcher.runs) return;
  // Re-read so a disable or an edit that raced the tick is honored.
  const factory = await getWatchedFactory(id);
  if (!factory || !(await hasWork(factory))) {
    unscheduleFactory(id);
    return;
  }
  watcher.flows?.noteFactory(factory);
  // Resuming and admitting both act as the enabler: both need their access.
  if (!(await enablerCanStillSteer(factory))) return;
  const target = await resolveTarget(factory);
  if (!target) return;
  // Reached the repository as the enabler: nothing blocks the factory (until
  // the listing or a launch below says otherwise), unless its base branch is
  // broken after a factory merge: then no factory on the repository admits.
  const incident = await superviseBase(factory, target.repo, target.mode);
  await reportBlocked(factory.id, incident);
  await reconcileParked(factory, target.repo);
  await retriageAnswered(factory, target.repo);
  await resumeRuns(factory, target.repo, target.mode);
  await watchEarlyIntegration(factory, target.repo);
  if (incident) return;
  // A paused factory finishes its runs but admits nothing new; its queue waits,
  // and its schedules start nothing.
  if (!factory.enabled) return;
  await queueDueTriggers(factory);
  await admitWork(factory, target.repo, target.mode);
}

/**
 * Queue one run for each schedule trigger whose occurrence has come (change
 * flow-triggers). The occurrence is taken first, as a compare-and-set, so only
 * one server instance queues it. An occurrence that is late by more than
 * `MISSED_OCCURRENCE_MS` (the server was down, or the factory paused) is
 * dropped; one whose trigger still has a run working is skipped and recorded.
 * The queued run is admitted by `admitWork`, under the factory's cap.
 */
async function queueDueTriggers(factory: WatchedFactory): Promise<void> {
  if (!watcher.runs || !watcher.deps) return;
  const triggers = watcher.deps.triggers ?? createFactoryTriggersRepository();
  const now = (watcher.deps.now ?? (() => new Date()))();
  const due = await triggers.due(factory.id, now);
  if (due.isErr()) {
    log.warn('Issue factory could not read its schedule triggers', {
      namespace: 'factory',
      factoryId: factory.id,
      error: due.error.message,
    });
    return;
  }
  for (const trigger of due.value) await queueOccurrence(factory, trigger, triggers, now);
}

/** One due occurrence of a schedule trigger: taken, then queued, dropped or skipped. */
async function queueOccurrence(
  factory: WatchedFactory,
  trigger: FactoryTrigger,
  triggers: FactoryTriggersRepository,
  now: Date,
): Promise<void> {
  const at = trigger.nextRunAt;
  if (!at || !watcher.runs || !watcher.deps) return;
  const taken = await triggers.take(trigger, at, now);
  if (taken.isErr() || !taken.value) return;
  if (now.getTime() - Date.parse(at) > MISSED_OCCURRENCE_MS) {
    log.info('Issue factory dropped a missed schedule occurrence', {
      namespace: 'factory',
      factoryId: factory.id,
      triggerId: trigger.id,
      due: at,
    });
    return;
  }
  const queued = await watcher.runs.enqueueIssueless({
    factoryId: factory.id,
    flowName: trigger.flowName,
    source: 'schedule',
    trigger: { id: trigger.id, name: trigger.name },
    inputs: trigger.inputs,
  });
  if (queued.isErr()) {
    log.error('Issue factory could not queue a scheduled run', {
      namespace: 'factory',
      factoryId: factory.id,
      triggerId: trigger.id,
      error: queued.error.message,
    });
    return;
  }
  // Refused by the one-run-per-trigger index: its previous run is still working.
  if (!queued.value) await recordSkippedTrigger(factory, trigger, at);
}

/** Tell the enabler an occurrence started no run (track-funny-actions). */
async function recordSkippedTrigger(
  factory: WatchedFactory,
  trigger: FactoryTrigger,
  due: string,
): Promise<void> {
  await (watcher.deps?.activities ?? serverActivities).recordServerActivity(
    {
      kind: 'factory.trigger_skipped',
      userId: factory.userId,
      projectId: factory.projectId,
      title: `Skipped the schedule "${trigger.name}": its previous run is still working`,
      input: { triggerId: trigger.id, flowName: trigger.flowName, due },
      origin: 'system',
    },
    { ok: true, effects: [] },
  );
}

/** Each factory's last look at its repository's base head (early integration, D8). */
const baseHeads = new Map<string, string>();
/** Each stacked run's last look at its blocker's head (D10). */
const blockerHeads = new Map<string, string>();

/**
 * Early integration (openspec factory-integration D8): when the base moved
 * since the last tick, the factory's runs whose changes overlap it and whose
 * pull requests no longer merge integrate now, not at merge time.
 */
async function watchEarlyIntegration(factory: WatchedFactory, repo: string): Promise<void> {
  if (!watcher.runs || !watcher.deps || !watcher.flows) return;
  const github = watcher.deps.github;
  const driver = watcher.flows;
  const repository = watcher.runs;
  const host = github.pullRequests.integrationFor?.({
    userId: factory.userId,
    projectId: factory.projectId,
  });
  if (!host) return;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  const asked = await integrateEarly({
    lastBase: baseHeads,
    key: `${factory.id}:${repo}`,
    head: async () => (await github.defaultBranchHead(reader)).map((h) => h.sha).unwrapOr(null),
    changedPaths: async (from, to) => (await host.changedPaths(repo, from, to)).unwrapOr(null),
    candidates: async () => {
      const listed = await repository.list(factory.id);
      if (listed.isErr()) return [];
      return listed.value.flatMap((run) => {
        const prNumber = prNumberOf(run.prUrl);
        const inFlight = (IN_FLIGHT_STATES as readonly string[]).includes(run.state);
        if (prNumber === null || !inFlight) return [];
        const paths = run.risk?.paths ?? contractOf(run)?.likelyPaths ?? [];
        return [{ runId: run.id, prNumber, paths }];
      });
    },
    mergeable: async (prNumber) =>
      (await host.pullRequestMergeability(repo, prNumber)).map((pr) => pr.mergeable).unwrapOr(null),
    integrate: (runId) => driver.earlyIntegrate(runId),
  });
  const stacked = await integrateStacked({
    lastBlockerHead: blockerHeads,
    candidates: async () => {
      const listed = await repository.list(factory.id);
      if (listed.isErr()) return [];
      return listed.value.flatMap((run) => {
        const on = run.stackedOn;
        const inFlight = (IN_FLIGHT_STATES as readonly string[]).includes(run.state);
        if (!on || on.retargeted || !inFlight) return [];
        const blocker = listed.value.find((other) => other.id === on.runId);
        const blockerPr = prNumberOf(blocker?.prUrl ?? null);
        return blockerPr === null ? [] : [{ runId: run.id, blockerPr }];
      });
    },
    blockerHead: async (prNumber) =>
      (await host.pullRequestMergeability(repo, prNumber)).map((pr) => pr.headSha).unwrapOr(null),
    integrate: (runId) => driver.earlyIntegrate(runId),
  });
  for (const { runId, outcome } of [...asked, ...stacked]) {
    log.info('Issue factory early integration', {
      namespace: 'factory',
      factoryId: factory.id,
      runId,
      outcome,
    });
  }
}

/**
 * The sentinel's look at the repository's base branch for this tick (change
 * factory-agent-roles, D10): why the factory admits nothing now, or null.
 */
async function superviseBase(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
): Promise<string | null> {
  if (!watcher.runs || !watcher.deps) return null;
  const d = watcher.deps;
  const repository = watcher.runs;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  const sentinel = createFactorySentinel(
    {
      incidents: d.incidents ?? createFactoryIncidentsRepository(),
      recentMerges: async (ofRepo, since) => {
        const merged = await repository.mergedSince(ofRepo, since);
        if (merged.isErr()) return [];
        return merged.value.flatMap((run) =>
          run.prUrl && run.issueNumber !== null
            ? [
                {
                  issueNumber: run.issueNumber,
                  prUrl: run.prUrl,
                  mergedAt: run.completedAt ?? run.startedAt,
                  userId: run.userId,
                },
              ]
            : [],
        );
      },
      defaultBranch: async () => {
        const branch = await d.github.defaultBranch(reader);
        return branch.isOk() ? branch.value : null;
      },
      branchState: async (branch) => {
        const state = await d.github.branchState(reader, branch);
        return state.isOk() ? state.value : null;
      },
      mergeState: async (prNumber) => {
        const state = await d.github.mergeCommitState(reader, prNumber);
        return state.isOk() ? state.value : null;
      },
      cleared: clearedRedCommits,
      launch: (body) => launchFor(d)({ userId: factory.userId, body }),
      threadStatus: sentinelThreadStatus,
      finalMessage: d.lastThreadMessage ?? lastThreadMessage,
      revert: async (prNumber, text) => {
        const reverted = await d.github.revertPullRequest(reader, prNumber, text);
        return reverted.isOk() ? ok({ url: reverted.value.url }) : err(reverted.error);
      },
      notify: d.notify ?? sendPush,
      retire: async (threadId) => {
        await finishRoleThreadStage(threadId, 'factory sentinel answered');
        // Read-only, but its checkout goes only when nothing in it would be lost.
        await cleanupFactoryWorktrees(d.ports, factory.userId, [threadId], d.browserEvents, {
          keepUnsaved: true,
        });
      },
      mode,
    },
    factory,
    repo,
  );
  return sentinel.superviseBase();
}

/**
 * Red base commits the sentinel found were no factory merge's, kept so a tick
 * does not read the same merge commits again. Bounded: the oldest go first.
 */
const clearedRedCommits = new (class extends Set<string> {
  override add(key: string): this {
    if (this.size >= 500) this.delete(this.values().next().value as string);
    return super.add(key);
  }
})();

/** A thread's stored status, or null when it is gone. */
async function sentinelThreadStatus(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: threads.status })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.status ?? null;
}

/**
 * Runs parked on their issue (`needs_info`) whose issue changed since triage
 * asked, or was closed: back in the queue, where admission triages an open one
 * again when a slot is free and drops a closed one. An issue that cannot be
 * read now is looked at again next tick.
 */
async function retriageAnswered(factory: WatchedFactory, repo: string): Promise<void> {
  if (!watcher.runs || !watcher.deps) return;
  const waiting = await watcher.runs.needingInfo(factory.id);
  if (waiting.isErr()) return;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  for (const run of waiting.value) {
    if (run.issueNumber === null) continue;
    const issue = await watcher.deps.github.getIssue(reader, run.issueNumber);
    if (issue.isErr()) continue;
    const answered =
      issue.value.state === 'closed' || issueChangedSince(run.triage, issue.value.updatedAt);
    if (!answered) continue;
    const moved = await watcher.runs.retriage(run);
    if (moved.isOk() && moved.value) {
      log.info('Issue factory triages an issue again: it changed', {
        namespace: 'factory',
        factoryId: factory.id,
        runId: run.id,
        issue: run.issueNumber,
      });
    }
  }
}

/**
 * An enabled factory, or a paused one with runs still in flight or a parked run
 * whose pull request a person may still merge or close (see `reconcileParked`).
 */
async function hasWork(factory: WatchedFactory): Promise<boolean> {
  if (factory.enabled) return true;
  const active = await watcher.runs!.countActive(factory.id);
  if (active.isErr() || active.value > 0) return true;
  const awaiting = await watcher.runs!.awaitingPullRequest(factory.id);
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
  const repo = await watcher.deps!.github.resolveRepo(factory.userId, factory.projectId);
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
  if (!watcher.deps) return null;
  return targetOf(factory);
}

/** The GitHub side the watcher reads through, while it runs. */
export function factoryGithubPort(): FactoryGithubPort | null {
  return watcher.deps?.github ?? null;
}

/**
 * The factory runs as its enabler, so it may only start threads while they
 * still hold `steer` on the project — re-checked every tick, since a role can
 * be lowered or a member removed after the factory was turned on. When they
 * lost it, the factory is turned off (and audited) instead of acting for them.
 */
async function enablerCanStillSteer(factory: WatchedFactory): Promise<boolean> {
  const check = watcher.deps?.checkAccess ?? defaultCheckAccess;
  if (await check(factory.userId, factory.projectId)) return true;
  await disableFactory(factory.id);
  unscheduleFactory(factory.id);
  await stopOpenRuns(factory);
  // The enabler sees why their factory stopped (track-funny-actions).
  await (watcher.deps?.activities ?? serverActivities).recordServerActivity(
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
  if (!watcher.runs || !watcher.deps) return;
  const all = await watcher.runs.list(factory.id);
  if (all.isErr()) return;
  const open = all.value.filter(
    (run) => !['merged', 'no_change', 'done', 'failed', 'stopped'].includes(run.state),
  );
  for (const run of open) watcher.flows?.stop(run.id);
  await watcher.runs.stopMany(open.map((run) => run.id));
  await stopFactoryThreads(
    watcher.deps.ports,
    factory.userId,
    open.flatMap((run) => threadsOf(run)),
  );
}

async function defaultCheckAccess(userId: string, projectId: string): Promise<boolean> {
  return (await decideProjectAccess(projectRole, 'steer', projectId, userId)) === null;
}

/**
 * Resume every run in flight whose flow is not running in this process — the
 * server restarted, or an earlier attempt to resume it stopped. The provider
 * replays the agent steps already recorded, so nothing starts twice.
 */
async function resumeRuns(factory: WatchedFactory, repo: string, mode: LaunchMode): Promise<void> {
  if (!watcher.runs || !watcher.flows || !watcher.deps) return;
  const inFlight = await watcher.runs.inFlight(factory.id);
  if (inFlight.isErr()) return;
  for (const run of inFlight.value) {
    if (watcher.flows.isActive(run.id)) continue;
    if (run.issueNumber === null) {
      void watcher.flows.start({ factory, repo, mode, issue: null, run });
      continue;
    }
    const issue = await watcher.deps.github.getIssue(
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
    void watcher.flows.start({ factory, repo, mode, issue: issue.value, run });
  }
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
  const runtime = await (watcher.deps?.resolveRuntime ?? defaultResolveRuntime)(userId, projectId);
  if (runtime === 'local') return 'worktree';
  return runtime === 'sandbox' && !watcher.deps?.launchSandbox ? null : runtime;
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
