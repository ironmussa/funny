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
import { reviewAllowsMerge } from '@funny/shared/contracts/factory';

import { log } from '../../lib/logger.js';
import { createBatchLeader } from './factory-batch-leader.js';
import type { FactoryBatchesRepository } from './factory-batches.js';
import { createMergeQueue, type BatchOutcome, type QueueMember } from './factory-merge-queue.js';
import { prNumberOf } from './factory-pull-requests.js';
import { factoryRunBranch, type FactoryRunView, type UpdateRunInput } from './factory-runs.js';
import type { WatchedFactory } from './factory-settings.js';

export interface FactoryQueuePortDeps {
  batches: FactoryBatchesRepository;
  run(runId: string): Promise<FactoryRunView | null>;
  factory(factoryId: string): Promise<WatchedFactory | null>;
  /** Write a member's run (only while it is in flight). */
  record(runId: string, input: UpdateRunInput): Promise<void>;
  integrationFor(owner: { userId: string; projectId: string }): IntegrationProvider;
  signal: AbortSignal;
  pollMs?: number;
}

/** What the leader's own flow asks of the queue (its `merge` options). */
export interface QueueGates {
  requireReview: boolean;
  requireRegressionProof: boolean;
}

/** Base branches whose up-to-date rule was learned from a refused merge (D3): batches of one there. */
const strictBranches = new Set<string>();

export function createFactoryQueuePort(deps: FactoryQueuePortDeps) {
  const providerFor = (member: Pick<QueueMember, 'userId' | 'projectId'>) =>
    deps.integrationFor({ userId: member.userId, projectId: member.projectId });

  /** Why `member` may not merge its recorded head, or null (the run's own records for that commit). */
  async function holdOf(member: QueueMember, gates: QueueGates): Promise<string | null> {
    const run = await deps.run(member.runId);
    if (!run) return 'the run is gone';
    const factory = await deps.factory(run.factoryId);
    if (gates.requireReview) {
      const verdict = run.reviews.find((review) => review.sha === member.headSha);
      if (!verdict) return `commit ${member.headSha} has no review`;
      if (!reviewAllowsMerge(verdict)) return `the review of commit ${member.headSha} did not pass`;
    }
    if (
      run.risk?.headSha === member.headSha &&
      run.risk.level === 'high' &&
      factory?.autoMerge !== 'all'
    ) {
      return `the change is high risk (${run.risk.reasons.join('; ')})`;
    }
    if (gates.requireRegressionProof) {
      const proof = run.regressionProof;
      if (!proof || proof.headSha !== member.headSha || proof.verdict !== 'pass') {
        return `commit ${member.headSha} has no passing regression proof`;
      }
    }
    return null;
  }

  return {
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
      if (!run || prNumber === null) return null;
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
      };
    },

    /**
     * Whether the base branch allows funny's batches: not where GitHub's merge
     * queue is required (D1: it is used instead) or pull requests must be up
     * to date (D3: batches of one, the serial path).
     */
    async batchable(leader: QueueMember): Promise<boolean> {
      if (strictBranches.has(`${leader.repo}:${leader.baseBranch}`)) return false;
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
      const deleted = await providerFor(member).deleteBranch(member.repo, factoryRunBranch(run));
      if (deleted.isErr()) {
        log.warn('Issue factory batch: a merged branch could not be deleted', {
          namespace: 'factory',
          runId: member.runId,
          error: deleted.error.message,
        });
      }
    },

    /** A member may not merge now: its run waits for a person, with the reason. */
    async recordHeld(member: QueueMember, reason: string): Promise<void> {
      await deps.record(member.runId, { state: 'waiting_human', failureReason: reason });
    },
  };
}

export type FactoryQueuePort = ReturnType<typeof createFactoryQueuePort>;
