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
import { errorMessage } from '@funny/shared/errors';
import { and, eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { projectSandboxSettings, threads } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';
import { serverActivities } from '../activities/server-activities.js';
import { type RunnerPorts } from '../runner-thread-launcher.js';
import type { ThreadRuntimeMode } from '../thread-sandboxes/project-sandbox-settings.js';
import { sendPush } from '../web-push.js';
import {
  deleteLease,
  dropExpired,
  leaseHolders,
  putLease,
} from '../workflow-engine/lease-store.js';
import { integrateEarly, integrateStacked } from './factory-early-watch.js';
import { createFactoryFlowRuns } from './factory-flow-runs.js';
import { reconcileFactoryFlowSetups } from './factory-flow-setup-live.js';
import { type FactoryGithubPort } from './factory-github.js';
import { createFactoryIncidentsRepository } from './factory-incidents.js';
import { checkLaneConflicts } from './factory-lane-conflicts.js';
import { watchFinishedLanes } from './factory-lane-finish.js';
import { createLaneSync } from './factory-lane-sync.js';
import { createFactoryLanesRepository } from './factory-lanes.js';
import { closeFinishedParents } from './factory-parent-close.js';
import { prNumberOf } from './factory-pull-requests.js';
import { checkLaneConflictsOnRunner, type FactoryStepJobBody } from './factory-runner-jobs.js';
import {
  createFactoryRunsRepository,
  IN_FLIGHT_STATES,
  threadsOf,
  type FactoryRunView,
} from './factory-runs.js';
import { createFactorySentinel } from './factory-sentinel.js';
import {
  disableFactory,
  getWatchedFactory,
  listWatchedFactories,
  type WatchedFactory,
} from './factory-settings.js';
import { createSpecHost } from './factory-spec-host.js';
import { setFactorySpecHost } from './factory-spec.js';
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
import { reconcileParked, reproving } from './factory-watcher-parked.js';
import {
  blockedReasons,
  cleanupMergedFor,
  closeSupersededFor,
  deps,
  flows,
  IN_FLIGHT,
  launchFor,
  reportBlocked,
  runs,
  setWatcherState,
  type CreatePoll,
  type FactoryPoll,
  type FactoryWatcherDeps,
  type LaunchMode,
} from './factory-watcher-state.js';

export { MAX_ATTEMPTS, pathsHeld, stackTarget } from './factory-watcher-admission.js';
export type { CreatePoll, FactoryWatcherDeps } from './factory-watcher-state.js';

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
  // SAFETY: project_sandbox_settings.mode is written only by project-sandbox-settings.ts, from ThreadRuntimeMode values.
  return (row?.mode as ThreadRuntimeMode) ?? 'local';
}

// ── Lifecycle ────────────────────────────────────────────────────

export async function startFactoryWatcher(d: FactoryWatcherDeps): Promise<void> {
  stopFactoryWatcher();
  const repository = d.runs ?? createFactoryRunsRepository();
  const proofService: NonNullable<FactoryWatcherDeps['proof']> =
    d.proof ??
    ((userId, _threadId) => ({
      startProof: (tid, body) => startRegressionProofOnRunner(d.ports, userId, tid, body),
      pollProof: (tid, proofId) => pollRegressionProofOnRunner(d.ports, userId, tid, proofId),
      cancelProof: (tid, proofId) => cancelRegressionProofOnRunner(d.ports, userId, tid, proofId),
    }));
  setWatcherState({ deps: d, runs: repository, proofs: proofService });
  const steps =
    d.steps ??
    ((userId: string) => ({
      startStep: (tid: string, body: FactoryStepJobBody) =>
        startFactoryStepOnRunner(d.ports, userId, tid, body),
      pollStep: (tid: string, stepId: string) =>
        pollFactoryStepOnRunner(d.ports, userId, tid, stepId),
      cancelStep: (tid: string, stepId: string) =>
        cancelFactoryStepOnRunner(d.ports, userId, tid, stepId),
    }));
  setWatcherState({
    flows: createFactoryFlowRuns({
      steps,
      runs: repository,
      github: d.github,
      launch: launchFor(d),
      waitThread: d.waitThread,
      lastThreadMessage: d.lastThreadMessage,
      loadFlow: d.loadFlow,
      notify: d.notify,
      gate: d.gate,
      proof: proofService,
      reportBlocked: (factoryId, reason) => reportBlocked(factoryId, reason),
      stopThreads: (userId, threadIds) => stopFactoryThreads(d.ports, userId, threadIds),
      cleanupMerged: (userId, threadIds) => cleanupMergedFor(d, userId, threadIds),
      closeSuperseded: (runId, repo) => closeSupersededOf(runId, repo),
      cleanupUnchanged: (userId, threadIds) =>
        d.cleanupUnchanged
          ? d.cleanupUnchanged(userId, threadIds)
          : cleanupFactoryWorktrees(d.ports, userId, threadIds, d.browserEvents, {
              keepUnsaved: true,
            }),
      cleanupRoleThread: async (userId, threadId) => {
        await cleanupFactoryWorktrees(d.ports, userId, [threadId], d.browserEvents, {
          keepUnsaved: true,
          reason: 'review-finished',
        });
      },
      followUp:
        d.followUp ??
        ((userId, threadId, content, expectedBranch, options) =>
          sendFactoryFollowUp(d.ports, userId, threadId, content, expectedBranch, options)),
    }),
  });
  setFactorySpecHost(createSpecHost(d, repository, (factory) => checkFactoryTarget(factory)));
  for (const factory of await listWatchedFactories([...IN_FLIGHT_STATES])) schedule(factory);
  // Reconcile any in-flight factory flow setups on server start and periodically.
  if (!d.createPoll) {
    void reconcileFactoryFlowSetups().catch((cause: unknown) =>
      log.warn('Initial factory flow setup reconciliation failed', {
        namespace: 'factory',
        error: errorMessage(cause),
      }),
    );
    const setupJob = startIntervalPoll(async () => {
      try {
        await reconcileFactoryFlowSetups();
      } catch (cause: unknown) {
        log.warn('Periodic factory flow setup reconciliation failed', {
          namespace: 'factory',
          error: errorMessage(cause),
        });
      }
    });
    jobs.set('__flow_setup_reconcile__', setupJob);
  }
  log.info('Issue factory watcher started', { namespace: 'factory', jobs: jobs.size });
}

export function stopFactoryWatcher(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  busy.clear();
  blockedReasons.clear();
  for (const controller of reproving.values()) controller.abort();
  reproving.clear();
  setWatcherState({ proofs: null });
  flows?.stopAll();
  setFactorySpecHost(null);
  setWatcherState({ flows: null, deps: null, runs: null });
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

/**
 * A member splits `run`, parked because its issue is too large: open the
 * parts triage proposed as issues of the factory's repository, as the
 * enabler (see `splitParked`). The issues opened, or why nothing was.
 */
export async function splitParkedFactoryRun(
  run: FactoryRunView,
): Promise<Result<number[], string>> {
  if (!deps || !flows) return err('The issue factory is not running on this server.');
  if (run.issueNumber === null) return err('The run has no issue to split.');
  const factory = await getWatchedFactory(run.factoryId);
  if (!factory) return err('The factory is not enabled.');
  const target = await targetOf(factory);
  if ('reason' in target) return err(target.reason);
  const issue = await deps.github.getIssue(
    { repo: target.repo, ownerId: factory.userId, projectId: factory.projectId },
    run.issueNumber,
  );
  if (issue.isErr()) return err(`The issue could not be read: ${issue.error.message}`);
  return flows.splitParked({
    factory,
    repo: target.repo,
    mode: target.mode,
    issue: issue.value,
    run,
  });
}

/** The runner ports the watcher acts through, while it runs. */
export function factoryRunnerPorts(): RunnerPorts | null {
  return deps?.ports ?? null;
}

/** Where the watcher tells the enabler's browsers about changed threads, while it runs. */
export function factoryBrowserEvents(): BrowserEventsPort | undefined {
  return deps?.browserEvents;
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
    .catch((cause: unknown) => {
      log.error('Issue factory tick failed', {
        namespace: 'factory',
        factoryId: id,
        error: errorMessage(cause),
      });
    })
    .finally(() => busy.delete(id));
}

async function resolveOwnIncident(
  factory: WatchedFactory,
  repo: string,
  incidents: Map<string, string>,
): Promise<string | null> {
  if (!deps || incidents.size === 0) return null;
  const ownBase = (
    await deps.github.defaultBranch({
      repo,
      ownerId: factory.userId,
      projectId: factory.projectId,
    })
  ).unwrapOr(null);
  return ownBase ? (incidents.get(ownBase) ?? null) : (incidents.values().next().value ?? null);
}

async function runEnabledSteps(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  ownIncident: string | null,
  incidents: Map<string, string>,
): Promise<void> {
  // A broken "Merge into" branch is not carried into the lanes (D6).
  if (!ownIncident) await syncLanes(factory, repo, mode);
  // Once a day, the lanes are tried against each other on the enabler's runner (D7).
  await checkLanesAgainstEachOther(factory);
  if (!ownIncident) await queueDueTriggers(factory);
  await admitWork(factory, repo, mode, incidents);
}

async function fire(id: string): Promise<void> {
  if (!deps || !runs) return;
  // Re-read so a disable or an edit that raced the tick is honored.
  const factory = await getWatchedFactory(id);
  if (!factory || !(await hasWork(factory))) {
    unscheduleFactory(id);
    return;
  }
  flows?.noteFactory(factory);
  // Resuming and admitting both act as the enabler: both need their access.
  if (!(await enablerCanStillSteer(factory))) return;
  const target = await resolveTarget(factory);
  if (!target) return;
  // Reached the repository as the enabler: nothing blocks the factory (until
  // the listing or a launch below says otherwise), unless its base branch is
  // broken after a factory merge: then only that base pauses (openspec
  // factory-lanes, D6).
  const incidents = await superviseBases(factory, target.repo, target.mode);
  const ownIncident = await resolveOwnIncident(factory, target.repo, incidents);
  await reportBlocked(factory.id, ownIncident);
  await reconcileParked(factory, target.repo);
  await retriageAnswered(factory, target.repo);
  await closeParentsOf(factory, target.repo);
  await resumeRuns(factory, target.repo, target.mode);
  await watchEarlyIntegration(factory, target.repo);
  // A lane whose final pull request merged is finished before its sync is looked at.
  await watchFinishedLanes(
    { github: deps.github, lanes: laneRows, activities: deps.activities ?? serverActivities },
    {
      factoryId: factory.id,
      reader: { repo: target.repo, ownerId: factory.userId, projectId: factory.projectId },
    },
  );
  // A paused factory finishes its runs but admits nothing new; its queue waits,
  // and its schedules start nothing.
  if (!factory.enabled) return;
  await runEnabledSteps(factory, target.repo, target.mode, ownIncident, incidents);
}

/**
 * Advance the sync of each of the factory's lanes with the branch it merges
 * into by one step (openspec factory-lanes, D4), as the enabler. The reader
 * carries no run's base: "the base" here is the factory's own branch.
 */
async function syncLanes(factory: WatchedFactory, repo: string, mode: LaunchMode): Promise<void> {
  if (!deps?.github.laneBranches) return;
  const d = deps;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  const github = deps.github;
  await createLaneSync(
    {
      lanes: laneRows,
      branches: github.laneBranches!(reader),
      pullRequests: github.pullRequests,
      baseBranch: async (lane) =>
        lane.baseBranch ?? (await github.defaultBranch(reader)).unwrapOr(null),
      activities: deps.activities ?? serverActivities,
      mergeTurn: {
        holders: async (group) => {
          // A lease whose server stopped is not a holder.
          await dropExpired(group, Date.now());
          return leaseHolders(group);
        },
        take: (group, holder, until) => putLease(group, holder, Date.now(), until),
        release: (group, holder) => deleteLease(group, holder),
      },
      agent: {
        start: async (input) => {
          const launched = await launchFor(d)({
            userId: factory.userId,
            body: {
              projectId: factory.projectId,
              title: input.title,
              mode,
              // The scratch branch is the lane's head: the thread works on it and pushes it.
              baseBranch: input.baseBranch,
              baseFromRemote: mode === 'worktree',
              branch: input.branch,
              requireBranch: true,
              source: 'factory',
              permissionMode: 'autoEdit',
              prompt: input.prompt,
            },
          });
          if (launched.isErr()) return { error: launched.error.message };
          return launched.value.threadId
            ? { threadId: launched.value.threadId }
            : { error: 'the runner returned no thread' };
        },
        followUp: async (threadId, content, branch) => {
          const send =
            d.followUp ??
            ((userId: string, id: string, text: string, expected?: string) =>
              sendFactoryFollowUp(d.ports, userId, id, text, expected));
          return (await send(factory.userId, threadId, content, branch)).isOk();
        },
        turn: syncThreadTurn,
      },
    },
    { factoryId: factory.id, reader },
  ).tick();
}

const laneRows = createFactoryLanesRepository();

/** Factory id → when its cross-lane conflict check last failed (retried after an hour). */
const laneConflictFailures = new Map<string, number>();

/** The daily cross-lane conflict check (D7), on the enabler's runner, as the enabler. */
async function checkLanesAgainstEachOther(factory: WatchedFactory): Promise<void> {
  if (!deps) return;
  const ports = deps.ports;
  await checkLaneConflicts(
    {
      lanes: laneRows,
      check: (branches) =>
        checkLaneConflictsOnRunner(ports, factory.userId, factory.projectId, branches),
      failedAt: laneConflictFailures,
    },
    factory.id,
  );
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
  if (!runs || !deps) return;
  const triggers = deps.triggers ?? createFactoryTriggersRepository();
  const now = (deps.now ?? (() => new Date()))();
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
  if (!at || !runs || !deps) return;
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
  const queued = await runs.enqueueIssueless({
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
  await (deps?.activities ?? serverActivities).recordServerActivity(
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
  if (!runs || !deps || !flows) return;
  const github = deps.github;
  const driver = flows;
  const repository = runs;
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
        const inFlight = IN_FLIGHT.includes(run.state);
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
        const inFlight = IN_FLIGHT.includes(run.state);
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
 * The sentinel's look at every base branch with a recent factory merge or open
 * incident for this tick (change factory-lanes, D6): maps each broken base
 * branch to its incident reason.
 */
async function superviseBases(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
): Promise<Map<string, string>> {
  if (!runs || !deps) return new Map();
  const d = deps;
  const repository = runs;
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
                  baseBranch: run.baseBranch,
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
  return sentinel.superviseBases();
}

/**
 * Red base commits the sentinel found were no factory merge's, kept so a tick
 * does not read the same merge commits again. Bounded: the oldest go first.
 */
const clearedRedCommits = new (class extends Set<string> {
  override add(key: string): this {
    if (this.size >= 500) {
      // SAFETY: size >= 500 just held, so the iterator's first step yields a stored key.
      this.delete(this.values().next().value as string);
    }
    return super.add(key);
  }
})();

/** A sync agent's thread: its stored status and when its last turn ended, or null when it is gone. */
async function syncThreadTurn(
  threadId: string,
): Promise<{ status: string; completedAt: string | null } | null> {
  const [row] = await db
    .select({ status: threads.status, completedAt: threads.completedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row ? { status: row.status, completedAt: row.completedAt ?? null } : null;
}

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
  if (!runs || !deps) return;
  const waiting = await runs.needingInfo(factory.id);
  if (waiting.isErr()) return;
  const reader = { repo, ownerId: factory.userId, projectId: factory.projectId };
  for (const run of waiting.value) {
    if (run.issueNumber === null) continue;
    const issue = await deps.github.getIssue(reader, run.issueNumber);
    if (issue.isErr()) continue;
    const answered =
      issue.value.state === 'closed' || issueChangedSince(run.triage, issue.value.updatedAt);
    if (!answered) continue;
    const moved = await runs.retriage(run);
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
 * Close the issues whose work went to other issues once those are all closed
 * (`factory-parent-close.ts`), so the issues they block can start.
 */
async function closeParentsOf(factory: WatchedFactory, repo: string): Promise<void> {
  if (!runs || !deps) return;
  const all = await runs.list(factory.id);
  if (all.isErr()) return;
  const repository = runs;
  await closeFinishedParents(
    {
      github: deps.github,
      activities: deps.activities ?? serverActivities,
      recordTriage: async (runId, triage) => {
        const saved = await repository.update(runId, { triage });
        if (saved.isErr()) {
          log.warn('Issue factory could not mark a closed parent issue', {
            namespace: 'factory',
            runId,
            error: saved.error.message,
          });
        }
      },
    },
    { repo, ownerId: factory.userId, projectId: factory.projectId },
    all.value,
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

/** `closeSupersededFor` for a run of any factory: its factory and, unless given, its repository. */
async function closeSupersededOf(runId: string, repo?: string): Promise<void> {
  if (!runs) return;
  const run = (await runs.get(runId)).unwrapOr(null);
  const factory = run ? await getWatchedFactory(run.factoryId) : null;
  if (!factory) return;
  if (repo) return closeSupersededFor(factory, repo, runId);
  const target = await targetOf(factory);
  if ('reason' in target) return;
  return closeSupersededFor(factory, target.repo, runId);
}

/** The GitHub side the watcher reads through, while it runs. */
export function factoryGithubPort(): FactoryGithubPort | null {
  return deps?.github ?? null;
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
  const open = all.value.filter(
    (run) => !['merged', 'no_change', 'done', 'failed', 'stopped'].includes(run.state),
  );
  for (const run of open) flows?.stop(run.id);
  await runs.stopMany(open.map((run) => run.id));
  await stopFactoryThreads(
    deps.ports,
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
  if (!runs || !flows || !deps) return;
  const inFlight = await runs.inFlight(factory.id);
  if (inFlight.isErr()) return;
  for (const run of inFlight.value) {
    if (flows.isActive(run.id)) continue;
    if (run.issueNumber === null) {
      void flows.start({ factory, repo, mode, issue: null, run });
      continue;
    }
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
