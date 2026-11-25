/**
 * Parked runs of the issue-factory watcher (`factory-watcher.ts`): closes the
 * runs whose pull request a person finished outside the factory, and proves
 * the moved head of a run waiting on GitHub's auto-merge.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { RegressionProofOpts } from '@funny/workflows/compiler';

import { log } from '../../lib/logger.js';
import { flowReadsOf, loadFactoryFlow } from './factory-flow.js';
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
  threadsOf,
  type FactoryRunView,
  type RegressionProofRecord,
} from './factory-runs.js';
import { type WatchedFactory } from './factory-settings.js';
import { runsPushedCommits } from './factory-thread-waits.js';
import {
  cleanupMergedFor,
  closeSupersededFor,
  deps,
  proofs,
  runs,
} from './factory-watcher-state.js';

/** Parked runs whose new head is being proved now, by run id. */
export const reproving = new Map<string, AbortController>();

/**
 * Close the parked runs whose pull request a person merged (or closed) outside
 * the factory, e.g. after the run waited for them at a CI check that could not
 * run: otherwise they stay "waiting for you" and hold their issue. Works for any
 * flow: a run with no recorded pull request (its flow has no `create_pr` step)
 * is looked up by its branch. Best effort: a pull request that cannot be read
 * now is looked at again on the next tick.
 */
export async function reconcileParked(factory: WatchedFactory, repo: string): Promise<void> {
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
  const flow = await loadFactoryFlow(run.flowName ?? factory.flowName, flowReadsOf(github, reader));
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
  if (!deps || run.issueNumber === null) return null;
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
    .catch((cause: unknown) => {
      log.error("Issue factory failed while proving a parked run's new head", {
        namespace: 'factory',
        runId: run.id,
        headSha: target.sha,
        error: String(cause),
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
  if (pr.value !== 'merged') return;
  await cleanupMergedFor(deps, factory.userId, threadsOf(run));
  await closeSupersededFor(factory, repo, run.id);
}
