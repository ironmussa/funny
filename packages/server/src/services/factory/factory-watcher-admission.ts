/**
 * Admission of the issue-factory watcher (`factory-watcher.ts`): keeps the
 * factory's labelled issues in its queue and starts queued runs, in queue
 * order, as the free slots, their blockers and their likely paths allow.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { IssueBlocker } from '@funny/core/github-app';
import { sleep as interruptibleSleep } from '@funny/shared/async';
import type { FactoryStackedOn, FactoryWaitReason } from '@funny/shared/contracts/factory';
import { contractOf } from '@funny/shared/contracts/factory';

import { log } from '../../lib/logger.js';
import {
  sameWaitReason,
  unfinishedBlockers,
  waitReasonFor,
  type LatestRunState,
} from './factory-dependencies.js';
import { flowReadsOf, loadFactoryFlow } from './factory-flow.js';
import { READY_ISSUES_PAGE, type FactoryIssue, type FactoryRepoReader } from './factory-github.js';
import {
  factoryRunBranch,
  NO_FREE_SLOT,
  type FactoryRunState,
  type FactoryRunView,
} from './factory-runs.js';
import { type WatchedFactory } from './factory-settings.js';
import { allAwaitApproval, busyPathsOf, overlappingIssues } from './factory-triage.js';
import { deps, flows, reportBlocked, runs, type LaunchMode } from './factory-watcher-state.js';

/** How long admission waits for a run's first agent before counting it as started. */
const ADMIT_WAIT_MS = 15 * 1000;

/** Runs of an issue that may fail before the factory stops re-admitting it. */
export const MAX_ATTEMPTS = 3;

/** What one admission pass knows: the factory's runs, and the blockers read so far. */
interface AdmissionContext {
  reader: FactoryRepoReader;
  latestRuns: LatestRunState;
  /** Issues whose latest run handed its work to other issues (`delegatedWork`). */
  delegated: ReadonlySet<number>;
  /** Issues waiting in the queue (`requested`). */
  queued: ReadonlySet<number>;
  /** Blockers read this pass, by issue (null: unreadable). */
  blockers: Map<number, Promise<IssueBlocker[] | null>>;
  /** Whether each flow read this pass is proof-ready, by name. */
  proofReady: Map<string, Promise<boolean>>;
  /** Every run of the factory, as read for this pass (their likely paths). */
  runs: FactoryRunView[];
  /** Set when the factory keeps the paths of a run parked for a member's approval. */
  approvalHold: { now: number } | null;
}

/**
 * A run that ended handing its issue's work to other issues: triage split it
 * (`splitInto`) or found it tracked by existing issues (`existing`).
 */
export function delegatedWork(run: Pick<FactoryRunView, 'state' | 'triage'>): boolean {
  if (run.state !== 'done') return false;
  return (run.triage?.splitInto?.length ?? 0) > 0 || (run.triage?.existing?.length ?? 0) > 0;
}

function admissionContext(
  factory: WatchedFactory,
  repo: string,
  all: FactoryRunView[],
): AdmissionContext {
  // `list` is newest first: the first run seen for an issue is its latest.
  const latestRuns = new Map<number, FactoryRunState>();
  const delegated = new Set<number>();
  for (const run of all) {
    if (run.issueNumber === null || latestRuns.has(run.issueNumber)) continue;
    latestRuns.set(run.issueNumber, run.state);
    if (delegatedWork(run)) delegated.add(run.issueNumber);
  }
  return {
    reader: { repo, ownerId: factory.userId, projectId: factory.projectId },
    latestRuns,
    delegated,
    queued: new Set(
      all.flatMap((run) =>
        run.state === 'requested' && run.issueNumber !== null ? [run.issueNumber] : [],
      ),
    ),
    proofReady: new Map(),
    blockers: new Map(),
    runs: all,
    approvalHold: factory.holdPathsAwaitingApproval ? { now: Date.now() } : null,
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
    delegated: ctx.delegated,
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
 * Fill the free slots from the factory's queue, in its order: the issues sent
 * to the factory and (automatic mode) its labelled issues, which each pass
 * records there first (`syncLabelledQueue`), so the queue shows every issue
 * that waits for a slot. A blocked issue is skipped, not waited on, so it does
 * not hold up the ones behind it.
 */
export async function admitWork(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
): Promise<void> {
  if (!runs) return;
  await syncLabelledQueue(factory, repo);
  const slots = await freeSlots(factory);
  if (slots <= 0) return;
  const all = await runs.list(factory.id);
  const queue = await runs.queue(factory.id);
  if (all.isErr() || queue.isErr()) return;
  const ctx = admissionContext(factory, repo, all.value);
  await admitQueue(factory, repo, mode, queue.value, slots, ctx);
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
    ready = loadFactoryFlow(name, flowReadsOf(deps!.github, ctx.reader)).then(
      (flow) => !flow.isOk() || flow.value.proofReady,
    );
    ctx.proofReady.set(name, ready);
  }
  return ready;
}

/** An admitted run whose flow is starting: whether its first agent started. */
interface Launch {
  started: Promise<boolean>;
}

/**
 * Admit queued runs in queue order while slots remain. The runs admitted in
 * one round start together, so free slots fill at once instead of one launch
 * after another; the round ends when each first agent started (or
 * `ADMIT_WAIT_MS` passed). A launch that failed gives its slot back, and the
 * next round offers it to the runs behind.
 */
async function admitQueue(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  queue: FactoryRunView[],
  slots: number,
  ctx: AdmissionContext,
): Promise<void> {
  let left = slots;
  let next = 0;
  let full = false;
  while (!full && left > 0 && next < queue.length) {
    const launches: Promise<boolean>[] = [];
    while (launches.length < left && next < queue.length) {
      const admitted = await admitQueued(factory, repo, mode, queue[next++], ctx);
      // Another writer (a Retry, a take-over) took the last slot meanwhile.
      if (admitted === NO_FREE_SLOT) {
        full = true;
        break;
      }
      if (admitted) launches.push(admitted.started);
    }
    const started = await Promise.all(launches);
    left -= started.filter(Boolean).length;
  }
}

/**
 * Admit one queued issue when nothing holds it back: its starting flow, false
 * when it waits, or `NO_FREE_SLOT` when the factory filled up since the pass
 * counted.
 */
async function admitQueued(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  run: FactoryRunView,
  ctx: AdmissionContext,
): Promise<Launch | false | typeof NO_FREE_SLOT> {
  if (!runs || !deps) return false;
  if (run.issueNumber === null) return admitAndStart(factory, repo, mode, null, run);
  if (await heldWithoutProofRules(factory, run, ctx)) return false;
  // The issue first: one closed since it was sent leaves the queue even while
  // something still blocks it.
  const issue = await openQueuedIssue(factory, run, ctx);
  if (!issue) return false;

  const blocked = await blockedReason(ctx, issue.number);
  const stackedOn = stackTarget(factory, ctx, blocked);
  const reason = (stackedOn ? null : blocked) ?? pathsHeld(ctx, run, stackedOn);
  await noteWaitReason(run, reason);
  if (reason) return false;

  return admitAndStart(factory, repo, mode, issue, run, stackedOn);
}

/**
 * Take the run out of the queue and start its flow (not awaited: the caller
 * waits for a round of launches together), or `NO_FREE_SLOT`. A run without an issue (change flow-triggers) comes
 * straight here: nothing to read from GitHub and no blockers.
 */
async function admitAndStart(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue | null,
  run: FactoryRunView,
  /** The run it starts on top of instead of waiting for (D10), or null. */
  stackedOn: FactoryStackedOn | null = null,
): Promise<Launch | false | typeof NO_FREE_SLOT> {
  if (!runs) return false;
  // The capacity check is part of the write: the slots counted at the start of
  // the pass may have been taken during the GitHub reads above.
  const admitted = await runs.admit(factory.id, run.id);
  if (admitted.isOk() && admitted.value === NO_FREE_SLOT) return NO_FREE_SLOT;
  // Cancelled meanwhile (or another pass took it): not ours to start.
  if (admitted.isErr() || admitted.value !== 'admitted') return false;
  if (stackedOn) await runs.update(run.id, { stackedOn });
  const started = startFlow(factory, repo, mode, issue, {
    ...run,
    state: 'queued',
    waitReason: null,
    stackedOn,
  });
  return { started };
}

/**
 * The run an issue stacks on instead of waiting (openspec factory-integration
 * D10): only with `dependencies: stack`, only when what holds it is one
 * blocker of this repository whose run is in flight with a pull request (its
 * branch exists to build on). Anything else waits as before.
 */
export function stackTarget(
  factory: Pick<WatchedFactory, 'dependencies'>,
  ctx: { runs: ReadonlyArray<Pick<FactoryRunView, 'id' | 'issueNumber' | 'state' | 'prUrl'>> },
  reason: FactoryWaitReason | null,
): FactoryStackedOn | null {
  if (factory.dependencies !== 'stack' || !reason) return null;
  const stackable =
    reason.kind === 'blocker-in-progress' || reason.kind === 'blocker-waiting-merge';
  if (!stackable || reason.blockers.length !== 1) return null;
  const issueNumber = reason.blockers[0]!;
  // `runs` is newest first: the blocker's latest run.
  const blocker = ctx.runs.find((run) => run.issueNumber === issueNumber);
  if (!blocker?.prUrl || !STACKABLE_STATES.has(blocker.state)) return null;
  return { runId: blocker.id, issueNumber, branch: factoryRunBranch(blocker), retargeted: false };
}

/** A blocker's run a later issue may stack on: its pull request is open and still worked on. */
const STACKABLE_STATES: ReadonlySet<FactoryRunState> = new Set([
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
  'waiting_human',
]);

/**
 * Why a queued run that already has a contract still waits: its likely paths
 * overlap a run in progress (change factory-agent-roles, D5). It starts, with
 * that contract, once the other run is no longer working on those files.
 */
export function pathsHeld(
  ctx: { runs: Parameters<typeof busyPathsOf>[0]; approvalHold?: { now: number } | null },
  run: Pick<FactoryRunView, 'id' | 'triage'> & Partial<Pick<FactoryRunView, 'prUrl'>>,
  stackedOn: Pick<FactoryStackedOn, 'runId'> | null,
): FactoryWaitReason | null {
  // A run with a pull request has no implementer to start: making it wait only
  // lets later runs merge first (openspec factory-merge-fewer-bounces, D5).
  if (run.prUrl) return null;
  const paths = contractOf(run)?.likelyPaths ?? [];
  if (paths.length === 0) return null;
  const busy = busyPathsOf(ctx.runs, run.id, stackedOn?.runId ?? null, ctx.approvalHold ?? null);
  const blockers = overlappingIssues(paths, busy);
  if (blockers.length === 0) return null;
  // Every run it waits for is parked for a member: say whom to ask (D6).
  const kind = allAwaitApproval(blockers, busy) ? 'paths-awaiting-approval' : 'paths-overlap';
  return { kind, blockers };
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
  if (run.issueNumber === null) return null;
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

/**
 * Keep the factory's labelled issues in its queue (automatic mode), so the
 * queue shows every issue that waits for a slot, not only the ones sent from
 * funny: a labelled issue that may run and has no run yet is queued behind
 * the others, oldest first as GitHub lists them, and a labelled issue that
 * waits there leaves it once it lost its label or was closed. A factory in
 * manual mode takes no issue by its label: its labelled ones leave the queue.
 */
async function syncLabelledQueue(factory: WatchedFactory, repo: string): Promise<void> {
  if (!runs || !deps) return;
  const waiting = await runs.queue(factory.id);
  if (waiting.isErr()) return;
  const labelled = waiting.value.filter((run) => run.source === 'label');
  if (factory.mode !== 'automatic') {
    await dropLabelled(factory, labelled, 'the factory is not in automatic mode');
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
  const listed = new Set(issues.value.map((issue) => issue.number));
  // A full page may leave issues out: missing from it is not proof the label is gone.
  if (issues.value.length < READY_ISSUES_PAGE) {
    const unlabelled = labelled.filter(
      (run) => run.issueNumber !== null && !listed.has(run.issueNumber),
    );
    await dropLabelled(factory, unlabelled, 'its issue lost the label or was closed');
  }
  await queueLabelled(factory, issues.value, waiting.value);
}

/** Queue the labelled issues that may run and are not waiting yet, in listing order. */
async function queueLabelled(
  factory: WatchedFactory,
  issues: FactoryIssue[],
  waiting: FactoryRunView[],
): Promise<void> {
  const inQueue = new Set(waiting.map((run) => run.issueNumber));
  const fresh: number[] = [];
  for (const issue of issues) {
    if (!inQueue.has(issue.number) && (await isAdmissible(factory.id, issue.number))) {
      fresh.push(issue.number);
    }
  }
  if (fresh.length === 0) return;
  // An issue another writer queued meanwhile is skipped by the one-run-per-issue index.
  const queued = await runs!.enqueue({
    factoryId: factory.id,
    issueNumbers: fresh,
    issueTitles: new Map(issues.map((issue) => [issue.number, issue.title])),
    flowName: factory.flowName,
    source: 'label',
  });
  if (queued.isErr()) {
    log.error('Issue factory could not queue its labelled issues', {
      namespace: 'factory',
      factoryId: factory.id,
      error: queued.error.message,
    });
  }
}

/** Take waiting labelled runs out of the queue (their label stays as it is). */
async function dropLabelled(
  factory: WatchedFactory,
  dropped: FactoryRunView[],
  reason: string,
): Promise<void> {
  for (const run of dropped) {
    await runs!.cancel(factory.id, run.id);
    log.info('Issue factory dropped a labelled issue from its queue', {
      namespace: 'factory',
      factoryId: factory.id,
      runId: run.id,
      issue: run.issueNumber,
      reason,
    });
  }
}

/**
 * A labelled issue may be queued when it has no run open (waiting, in
 * progress or parked for a person), none that merged or ended with no change, and has
 * failed fewer than `MAX_ATTEMPTS` times. A lookup that fails skips the issue this tick rather
 * than risk a second run.
 */
async function isAdmissible(factoryId: string, issueNumber: number): Promise<boolean> {
  if (!runs) return false;
  const existing = await runs.activeByIssue(factoryId, issueNumber);
  if (existing.isErr() || existing.value) return false;
  const settled = await runs.settledByEarlierRun(factoryId, issueNumber);
  if (settled.isErr() || settled.value) return false;
  const failures = await runs.failedCount(factoryId, issueNumber);
  return failures.isOk() && failures.value < MAX_ATTEMPTS;
}

/** Start an admitted run's flow; whether its first agent started. */
async function startFlow(
  factory: WatchedFactory,
  repo: string,
  mode: LaunchMode,
  issue: FactoryIssue | null,
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
    issue: issue?.number ?? null,
    source: run.source,
    mode,
    started,
  });
  return started === 'started';
}
