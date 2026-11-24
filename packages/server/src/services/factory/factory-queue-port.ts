/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * The merge queue as the `merge` step of a run uses it (openspec
 * factory-integration D2-D3): who the batch's members are (each run's row and
 * its factory's enabler), whether each may merge the head it is tested at
 * (the review, risk and proof that run recorded for that commit), whether the
 * base branch allows batching at all, and writing each member's outcome on
 * its own run. Every host call about a member uses its enabler's token.
 */

import type { IntegrationProvider } from '@funny/core/github-app';
import { reviewAllowsMerge, type FactoryRunMetrics } from '@funny/shared/contracts/factory';

import { log } from '../../lib/logger.js';
import { createBatchLeader } from './factory-batch-leader.js';
import type { FactoryBatchesRepository } from './factory-batches.js';
import {
  createMergeQueue,
  type BatchOutcome,
  type BatchStats,
  type QueueMember,
} from './factory-merge-queue.js';
import { prNumberOf } from './factory-pull-requests.js';
import { ciRunsOnQueueBranches } from './factory-readiness.js';
import { factoryRunBranch, type FactoryRunView, type UpdateRunInput } from './factory-runs.js';
import type { WatchedFactory } from './factory-settings.js';

export interface FactoryQueuePortDeps {
  batches: FactoryBatchesRepository;
  run(runId: string): Promise<FactoryRunView | null>;
  factory(factoryId: string): Promise<WatchedFactory | null>;
  /** Write a member's run (only while it is in flight). */
  record(runId: string, input: UpdateRunInput): Promise<void>;
  integrationFor(owner: { userId: string; projectId: string }): IntegrationProvider;
  /**
   * The default branch's GitHub Actions workflow files, as the leader's
   * enabler reads them; null when they cannot be read.
   */
  workflows?(leader: QueueMember): Promise<string[] | null>;
  signal: AbortSignal;
  pollMs?: number;
}

/** What the leader's own flow asks of the queue (its `merge` options). */
export interface QueueGates {
  requireReview: boolean;
  requireRegressionProof: boolean;
}

/** The changed paths a run recorded for commit `sha`, as a member's `paths` field. */
function pathsAt(run: FactoryRunView, sha: string): Pick<QueueMember, 'paths'> {
  const paths = run.risk?.headSha === sha ? run.risk.paths : undefined;
  return paths ? { paths } : {};
}

/** The run's review of `sha` does not allow a merge, or there is none. */
function reviewHold(run: FactoryRunView, sha: string): string | null {
  const verdict = run.reviews.find((review) => review.sha === sha);
  if (!verdict) return `commit ${sha} has no review`;
  return reviewAllowsMerge(verdict) ? null : `the review of commit ${sha} did not pass`;
}

/** `sha` is high risk and the factory merges only low-risk changes by itself. */
function riskHold(run: FactoryRunView, sha: string, mergesAll: boolean): string | null {
  const risk = run.risk;
  if (mergesAll || risk?.headSha !== sha || risk.level !== 'high') return null;
  return `the change is high risk (${risk.reasons.join('; ')})`;
}

/** `sha` has no passing regression proof. */
function proofHold(run: FactoryRunView, sha: string): string | null {
  const proof = run.regressionProof;
  const passed = proof?.headSha === sha && proof.verdict === 'pass';
  return passed ? null : `commit ${sha} has no passing regression proof`;
}

/** Base branches whose up-to-date rule was learned from a refused merge (D3): batches of one there. */
const strictBranches = new Set<string>();
/** Repositories whose queue branches got no CI (D12): no batch there until their workflows change. */
const noQueueCi = new Set<string>();
/** Whether a repository's workflows run on queue branches, read at most every few minutes. */
const queueCiRead = new Map<string, { runs: boolean; at: number }>();
const QUEUE_CI_TTL_MS = 5 * 60_000;

/** A run's counters after a batch it was in (D13). */
export function withBatchStats(
  metrics: FactoryRunMetrics,
  stats: BatchStats,
  flake: boolean,
): FactoryRunMetrics {
  return {
    ...metrics,
    queueWaitMs: metrics.queueWaitMs + stats.durationMs,
    batchSize: stats.size,
    bisectionRounds: metrics.bisectionRounds + stats.attempts,
    ciFlakes: metrics.ciFlakes + (flake ? 1 : 0),
  };
}

export function createFactoryQueuePort(deps: FactoryQueuePortDeps) {
  /**
   * Whether CI runs on the repository's queue branches: its workflows say so
   * and no batch found otherwise. Unreadable workflows: no batch (the serial
   * path never needs it). Without a reader (tests): assumed.
   */
  async function queueCiRuns(leader: QueueMember): Promise<boolean> {
    if (noQueueCi.has(leader.repo)) {
      const read = queueCiRead.get(leader.repo);
      // Learned from a batch: only a newer read of the workflows clears it.
      if (!read || Date.now() - read.at < QUEUE_CI_TTL_MS) return false;
      noQueueCi.delete(leader.repo);
    }
    if (!deps.workflows) return true;
    const cached = queueCiRead.get(leader.repo);
    if (cached && Date.now() - cached.at < QUEUE_CI_TTL_MS) return cached.runs;
    const files = await deps.workflows(leader);
    const runs = files !== null && ciRunsOnQueueBranches(files);
    queueCiRead.set(leader.repo, { runs, at: Date.now() });
    return runs;
  }

  const providerFor = (member: Pick<QueueMember, 'userId' | 'projectId'>) =>
    deps.integrationFor({ userId: member.userId, projectId: member.projectId });

  /**
   * A commit bisection already isolated as the cause of a red batch, back
   * unchanged (its agent made no fix): batching it again would only turn the
   * next batch red, at the cost of its other members.
   */
  async function culpritHold(member: QueueMember): Promise<string | null> {
    const culprit = await deps.batches.culpritAt(member.repo, member.runId, member.headSha);
    if (culprit.isErr() || !culprit.value) return null;
    return `commit ${member.headSha} made a merge queue batch fail before and has not changed since: a person decides`;
  }

  /** Why `member` may not merge its recorded head, or null (the run's own records for that commit). */
  async function holdOf(member: QueueMember, gates: QueueGates): Promise<string | null> {
    const run = await deps.run(member.runId);
    if (!run) return 'the run is gone';
    const factory = await deps.factory(run.factoryId);
    return (
      (await culpritHold(member)) ??
      (gates.requireReview ? reviewHold(run, member.headSha) : null) ??
      riskHold(run, member.headSha, factory?.autoMerge === 'all') ??
      (gates.requireRegressionProof ? proofHold(run, member.headSha) : null)
    );
  }

  return {
    culpritHold,

    /**
     * A member of the leader's batch, by run id, at its pull request's head
     * now (the commit the batch tests); null when it cannot be one.
     */
    async memberOf(
      runId: string,
      holder: string | null,
      at: { repo: string; baseBranch: string },
    ): Promise<QueueMember | null> {
      const run = await deps.run(runId);
      const prNumber = prNumberOf(run?.prUrl ?? null);
      // A regenerable change (D9) is merged alone: it leads its own batch of one.
      if (!run || prNumber === null || run.regenerateNode) return null;
      const factory = await deps.factory(run.factoryId);
      if (!factory) return null;
      const owner = { userId: factory.userId, projectId: factory.projectId };
      const pr = await deps.integrationFor(owner).pullRequestMergeability(at.repo, prNumber);
      if (pr.isErr() || pr.value.state !== 'open') return null;
      return {
        holder,
        runId,
        factoryId: factory.id,
        ...owner,
        prNumber,
        headSha: pr.value.headSha,
        repo: at.repo,
        baseBranch: at.baseBranch,
        method: 'squash',
        // The paths of the head it is tested at, when its last classification was of it.
        ...pathsAt(run, pr.value.headSha),
      };
    },

    /**
     * Whether the base branch allows funny's batches: not where GitHub's merge
     * queue is required (D1: it is used instead) or pull requests must be up
     * to date (D3: batches of one, the serial path).
     */
    async batchable(leader: QueueMember): Promise<boolean> {
      if (strictBranches.has(`${leader.repo}:${leader.baseBranch}`)) return false;
      if (!(await queueCiRuns(leader))) return false;
      const rules = await providerFor(leader).branchRules(leader.repo, leader.baseBranch);
      return rules.isOk() && !rules.value.mergeQueue && rules.value.upToDate !== true;
    },

    /** Lead the batch: the leader first, then the members in queue order. */
    async lead(
      members: QueueMember[],
      gates: QueueGates,
      left: (member: QueueMember) => boolean,
    ): Promise<BatchOutcome> {
      const queueDeps = {
        batches: deps.batches,
        providerFor,
        hold: (member: QueueMember) => holdOf(member, gates),
        left,
        onNoQueueCi: (repo: string) => {
          noQueueCi.add(repo);
          log.warn('Issue factory: CI did not run on a merge queue branch', {
            namespace: 'factory',
            repo,
          });
        },
        signal: deps.signal,
        pollMs: deps.pollMs,
      };
      const outcome = await createBatchLeader(createMergeQueue(queueDeps), queueDeps).lead(members);
      // A refusal after a landing on a branch whose rules could not be read:
      // it requires being up to date, so batches of one there from now on.
      if (outcome.result.partialLanding) {
        strictBranches.add(`${members[0]!.repo}:${members[0]!.baseBranch}`);
      }
      return outcome;
    },

    /** A member landed: its run is merged, and its branch deleted with its own token. */
    async recordMerged(member: QueueMember): Promise<void> {
      await deps.record(member.runId, { state: 'merged', currentStep: null });
      await this.deleteMergedBranch(member);
    },

    /** Delete a landed member's branch, with its own token; a failure is logged. */
    async deleteMergedBranch(member: QueueMember): Promise<void> {
      const run = await deps.run(member.runId);
      if (!run) return;
      // Pull requests stacked on it move to the base it landed on first (D10).
      const deleted = await providerFor(member).deleteBranch(
        member.repo,
        factoryRunBranch(run),
        member.baseBranch,
      );
      if (deleted.isErr()) {
        log.warn('Issue factory batch: a merged branch could not be deleted', {
          namespace: 'factory',
          runId: member.runId,
          error: deleted.error.message,
        });
      }
    },

    /** Add what a batch cost to a member's counters (D13). */
    async recordStats(member: QueueMember, stats: BatchStats, flake: boolean): Promise<void> {
      const run = await deps.run(member.runId);
      if (!run) return;
      await deps.record(member.runId, { metrics: withBatchStats(run.metrics, stats, flake) });
    },

    /** A member may not merge now: its run waits for a person, with the reason. */
    async recordHeld(member: QueueMember, reason: string): Promise<void> {
      await deps.record(member.runId, { state: 'waiting_human', failureReason: reason });
    },
  };
}

export type FactoryQueuePort = ReturnType<typeof createFactoryQueuePort>;
