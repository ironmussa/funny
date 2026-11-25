/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * What the leader of a merge batch does with it (openspec factory-integration
 * D2-D3), over the queue's parts (`factory-merge-queue.ts`): re-check every
 * member, build and test the batch, merge it as tested, and on a red batch
 * re-test then bisect. It returns a verdict per member; the caller settles
 * the members with them and returns the leader's own.
 */

import type { FailingCheck, IntegrationProvider } from '@funny/core/github-app';

import { log } from '../../lib/logger.js';
import {
  checksFeedbackOf,
  conflictFeedback,
  decide,
  eligible,
  endUnknown,
  endWith,
  landAll,
  resultOf,
  retest,
  startRow,
  type BatchLeaderContext,
  type Progress,
} from './factory-batch-leader-steps.js';
import type { FactoryBatch } from './factory-batches.js';
import {
  MAX_REBUILDS,
  type BatchOutcome,
  type MergeQueue,
  type MergeQueueDeps,
  type QueueMember,
} from './factory-merge-queue.js';

export function createBatchLeader(queue: MergeQueue, deps: MergeQueueDeps) {
  const ctx: BatchLeaderContext = { queue, deps };

  /** Batches of one, in order: each tested on the base as it is, landed when green. */
  async function oneByOne(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    expected: string[],
    progress: Progress,
  ): Promise<void> {
    for (const member of members) {
      if (deps.signal.aborted || progress.verdicts.has(member.runId)) continue;
      const base = await host.branchHead(batch.repo, batch.baseBranch);
      if (base.isErr()) return;
      const alone = await queue.testApart(
        host,
        batch,
        [member],
        base.value,
        expected,
        `solo-${member.prNumber}`,
      );
      if (alone.verdict.kind === 'red') {
        decide(progress, member, {
          kind: 'sent_back',
          why: 'checks',
          feedback: checksFeedbackOf(alone.verdict.checks, [member]),
        });
        continue;
      }
      if (alone.verdict.kind !== 'green') continue;
      const now = await queue.stillAsTested(host, [member], base.value);
      if (now.baseMoved || now.moved.length > 0) continue;
      const { landed } = await queue.land([member]);
      for (const { sha } of landed) decide(progress, member, { kind: 'merged', sha });
    }
  }

  /** Bisect, send the culprits back, and test the rest one by one when no half is red. */
  async function split(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    base: string,
    expected: string[],
    failing: FailingCheck[],
    progress: Progress,
  ): Promise<void> {
    await deps.batches.move(batch.id, 'bisect');
    const found = await queue.bisect(host, batch, members, base, expected, failing);
    for (const member of found.conflicted) {
      decide(progress, member, {
        kind: 'sent_back',
        why: 'conflict',
        feedback: conflictFeedback(member, members),
      });
    }
    for (const member of members) {
      const checks = found.culprits.get(member.runId);
      if (checks) {
        decide(progress, member, {
          kind: 'sent_back',
          why: 'checks',
          feedback: checksFeedbackOf(checks, members),
        });
      }
    }
    // No half red: the failure needs members that were in different halves.
    // Each is then its own batch, in queue order, on the base as it is then:
    // a green one lands, so the next is tested with it; a red one is its failure.
    if (!found.anyRed) await oneByOne(host, batch, members, expected, progress);
    for (const member of members) {
      decide(progress, member, {
        kind: 'requeued',
        why: 'not isolated by the bisection: tested again in a new batch',
      });
    }
    await deps.batches.move(batch.id, 'split', {
      result: resultOf(progress, `Red batch of ${members.length}: bisected.`),
    });
  }

  /** One build-and-test round; true when it ended the batch, false to rebuild without the moved members. */
  async function round(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    expected: string[],
    progress: Progress,
  ): Promise<{ done: true } | { done: false; members: QueueMember[] }> {
    const base = await host.branchHead(batch.repo, batch.baseBranch);
    if (base.isErr()) return endUnknown(ctx, batch, members, progress, base.error.message);
    const built = await queue.build(
      host,
      members,
      { staging: batch.stagingBranch, queue: batch.queueBranch, label: `Batch ${batch.id}` },
      base.value,
    );
    if ('error' in built) return endUnknown(ctx, batch, members, progress, built.error);
    for (const member of built.conflicted) {
      decide(progress, member, {
        kind: 'sent_back',
        why: 'conflict',
        feedback: conflictFeedback(member, members),
      });
    }
    if (built.merged.length === 0)
      return endWith(ctx, batch, progress, 'abandon', 'No member merged onto the base.');
    await deps.batches.move(batch.id, 'test', { baseSha: base.value, queueSha: built.sha });
    const tested = await testBatch(
      host,
      batch,
      built.merged,
      built.sha,
      base.value,
      expected,
      progress,
    );
    if (tested === null) return { done: true };
    const now = await queue.stillAsTested(host, built.merged, base.value);
    if (now.baseMoved || now.moved.length > 0) {
      for (const member of now.moved)
        decide(progress, member, { kind: 'requeued', why: 'its head moved' });
      return { done: false, members: built.merged.filter((m) => !now.moved.includes(m)) };
    }
    await landAll(ctx, host, batch, built.merged, tested, progress);
    return { done: true };
  }

  /**
   * Wait for the batch commit's verdict: the commit to merge on (a green one,
   * or the same tree green again after a red), or null when the batch ended
   * here (no CI, an unknown verdict, or a red that bisection settled).
   */
  async function testBatch(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    sha: string,
    base: string,
    expected: string[],
    progress: Progress,
  ): Promise<string | null> {
    const verdict = await queue.waitVerdict(host, batch.repo, sha, expected);
    if (verdict.kind === 'unknown' && verdict.noCi) {
      // Nobody is blamed: the members wait again, and the repository's next
      // merges take the serial path until CI runs on the queue branches.
      deps.onNoQueueCi?.(batch.repo);
      for (const member of members)
        decide(progress, member, { kind: 'requeued', why: verdict.why });
      await endWith(ctx, batch, progress, 'abandon', verdict.why);
      return null;
    }
    if (verdict.kind === 'unknown') {
      await endUnknown(ctx, batch, members, progress, verdict.why);
      return null;
    }
    if (verdict.kind === 'green') return sha;
    const again = await retest(ctx, host, batch, sha, expected);
    if (again.green) {
      progress.flake = true;
      return again.sha;
    }
    const failing = again.checks.length ? again.checks : verdict.checks;
    await split(host, batch, members, base, expected, failing, progress);
    return null;
  }

  /** Build and test until the batch ends or was rebuilt too often; then clean its branches up. */
  async function runRounds(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    expected: string[],
    progress: Progress,
  ): Promise<void> {
    let remaining = members;
    for (let attempt = 1; attempt <= MAX_REBUILDS && remaining.length > 0; attempt++) {
      if (attempt > 1 && !(await deps.batches.rebuild(batch.id, remaining)).unwrapOr(false)) break;
      const done = await round(host, batch, remaining, expected, progress);
      if (done.done) {
        remaining = [];
        break;
      }
      remaining = done.members;
    }
    for (const member of remaining) {
      decide(progress, member, { kind: 'requeued', why: 'the batch was rebuilt too often' });
    }
    await host.deleteBranch(batch.repo, batch.stagingBranch);
    await host.deleteBranch(batch.repo, batch.queueBranch);
    const ended = await deps.batches.get(batch.id);
    if (ended.isOk() && ended.value && !ended.value.endedAt) {
      await deps.batches.move(batch.id, 'abandon', {
        result: resultOf(progress, 'Rebuilt too often.'),
      });
    }
  }

  return {
    /** Lead the batch of `members` (the leader first, then the queue order). */
    async lead(members: QueueMember[]): Promise<BatchOutcome> {
      const started = Date.now();
      const statsOf = async (batchId: string | null) => ({
        size: members.length,
        attempts: batchId
          ? (await deps.batches.attemptsOf(batchId)).map((a) => a.length).unwrapOr(0)
          : 0,
        durationMs: Date.now() - started,
      });
      const progress: Progress = { verdicts: new Map(), flake: false, partialLanding: false };
      const remaining = await eligible(ctx, members, progress);
      if (remaining.length === 0) {
        return {
          verdicts: progress.verdicts,
          result: resultOf(progress, 'No member may merge.'),
          stats: await statsOf(null),
        };
      }
      const batch = await startRow(ctx, remaining);
      if (!batch) {
        for (const member of remaining)
          decide(progress, member, { kind: 'requeued', why: 'another batch is active' });
        return {
          verdicts: progress.verdicts,
          result: resultOf(progress, 'Another batch is active.'),
          stats: await statsOf(null),
        };
      }
      const host = deps.providerFor(members[0]!);
      const rules = await host.branchRules(batch.repo, batch.baseBranch);
      const expected = await queue.expectedChecks(
        host,
        remaining,
        rules.isOk() ? rules.value.requiredChecks : [],
      );
      if (expected.length === 0) {
        await endUnknown(
          ctx,
          batch,
          remaining,
          progress,
          'no check reports on these pull requests, so a batch cannot be tested',
        );
        return {
          verdicts: progress.verdicts,
          result: resultOf(progress, 'No check to test with.'),
          stats: await statsOf(batch.id),
        };
      }
      await runRounds(host, batch, remaining, expected, progress);
      log.info('Issue factory batch ended', {
        namespace: 'factory',
        batchId: batch.id,
        repo: batch.repo,
        members: members.length,
        landed: [...progress.verdicts.values()].filter((v) => v.kind === 'merged').length,
      });
      return {
        verdicts: progress.verdicts,
        result: resultOf(progress, 'Batch ended.'),
        stats: await statsOf(batch.id),
      };
    },
  };
}
