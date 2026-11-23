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
import type { FactoryBatch, FactoryBatchResult } from './factory-batches.js';
import {
  MAX_REBUILDS,
  type BatchOutcome,
  type MemberVerdict,
  type MergeQueue,
  type MergeQueueDeps,
  type QueueMember,
} from './factory-merge-queue.js';

/** The verdicts so far, and the members still in the batch. */
interface Progress {
  verdicts: Map<string, MemberVerdict>;
  flake: boolean;
  partialLanding: boolean;
}

const conflictFeedback = (member: QueueMember, others: QueueMember[]) =>
  [
    `Your pull request #${member.prNumber} does not merge onto the base together with the pull requests ahead of it in the queue (${others.map((m) => `#${m.prNumber}`).join(', ') || 'none'}).`,
    'Merge the base branch into your branch, keep both changes, run the tests, commit and push.',
  ].join('\n');

function resultOf(progress: Progress, summary: string): FactoryBatchResult {
  const by = (kind: MemberVerdict['kind']) =>
    [...progress.verdicts].flatMap(([runId, v]) => (v.kind === kind ? [runId] : []));
  return {
    summary,
    landed: [...progress.verdicts].flatMap(([runId, v]) =>
      v.kind === 'merged' ? [{ runId, sha: v.sha }] : [],
    ),
    culprits: [...progress.verdicts].flatMap(([runId, v]) =>
      v.kind === 'sent_back' && v.why === 'checks' ? [runId] : [],
    ),
    requeued: by('requeued'),
    flake: progress.flake,
    partialLanding: progress.partialLanding,
  };
}

export function createBatchLeader(queue: MergeQueue, deps: MergeQueueDeps) {
  const decide = (progress: Progress, member: QueueMember, verdict: MemberVerdict) => {
    if (!progress.verdicts.has(member.runId)) progress.verdicts.set(member.runId, verdict);
  };

  /** Members that may not merge their recorded head are held; the rest go on. */
  async function eligible(members: QueueMember[], progress: Progress): Promise<QueueMember[]> {
    const kept: QueueMember[] = [];
    for (const member of members) {
      const reason = await deps.hold(member);
      if (reason) decide(progress, member, { kind: 'held', reason });
      else kept.push(member);
    }
    return kept;
  }

  /** A batch row for the members; a stale one left by a stopped server is ended first. */
  async function startRow(members: QueueMember[]): Promise<FactoryBatch | null> {
    const leader = members[0]!;
    const stale = await deps.batches.active(leader.repo, leader.baseBranch);
    if (stale.isOk() && stale.value) await deps.batches.move(stale.value.id, 'abandon');
    const started = await deps.batches.start({
      repo: leader.repo,
      baseBranch: leader.baseBranch,
      leaderRunId: leader.runId,
      members,
    });
    return started.isOk() ? started.value : null;
  }

  /** Land the tested members in order; a refusal after a landing is a partial landing. */
  async function landAll(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    testedSha: string,
    progress: Progress,
  ): Promise<void> {
    await deps.batches.move(batch.id, 'merge');
    const { landed, refused } = await queue.land(members);
    for (const { member, sha } of landed) decide(progress, member, { kind: 'merged', sha });
    if (!refused) {
      await queue.checkTree(
        host,
        batch,
        testedSha,
        landed.map((l) => l.member.runId),
      );
      await deps.batches.move(batch.id, 'merged', {
        result: resultOf(progress, `Merged ${members.length} pull requests tested together.`),
      });
      return;
    }
    progress.partialLanding = landed.length > 0;
    if (landed.length === 0) {
      decide(progress, refused.member, {
        kind: 'held',
        reason: `The merge was refused: ${refused.reason}`,
      });
    }
    for (const member of members) {
      decide(progress, member, {
        kind: 'requeued',
        why: `the merge of #${refused.member.prNumber} was refused`,
      });
    }
    await deps.batches.move(batch.id, landed.length > 0 ? 'partial' : 'fail', {
      result: resultOf(
        progress,
        `Merging #${refused.member.prNumber} was refused: ${refused.reason}`,
      ),
    });
  }

  /** A red batch: once more on the same tree; then bisect. Whether it turned green (a flake). */
  async function retest(
    host: IntegrationProvider,
    batch: FactoryBatch,
    testedSha: string,
    expected: string[],
  ): Promise<{ green: true; sha: string } | { green: false; checks: FailingCheck[] }> {
    await deps.batches.move(batch.id, 'retest');
    const again = await host.sameTreeCommit(batch.repo, testedSha, `Batch ${batch.id}: test again`);
    if (again.isErr()) return { green: false, checks: [] };
    await host.setBranch(batch.repo, batch.queueBranch, again.value);
    const verdict = await queue.waitVerdict(host, batch.repo, again.value, expected);
    if (verdict.kind === 'green') return { green: true, sha: again.value };
    return { green: false, checks: verdict.kind === 'red' ? verdict.checks : [] };
  }

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
    if (base.isErr()) return endUnknown(batch, members, progress, base.error.message);
    const built = await queue.build(
      host,
      members,
      { staging: batch.stagingBranch, queue: batch.queueBranch, label: `Batch ${batch.id}` },
      base.value,
    );
    if ('error' in built) return endUnknown(batch, members, progress, built.error);
    for (const member of built.conflicted) {
      decide(progress, member, {
        kind: 'sent_back',
        why: 'conflict',
        feedback: conflictFeedback(member, members),
      });
    }
    if (built.merged.length === 0)
      return endWith(batch, progress, 'abandon', 'No member merged onto the base.');
    await deps.batches.move(batch.id, 'test', { baseSha: base.value, queueSha: built.sha });
    let tested = built.sha;
    const verdict = await queue.waitVerdict(host, batch.repo, tested, expected);
    if (verdict.kind === 'unknown' && verdict.noCi) {
      // Nobody is blamed: the members wait again, and the repository's next
      // merges take the serial path until CI runs on the queue branches.
      deps.onNoQueueCi?.(batch.repo);
      for (const member of built.merged) {
        decide(progress, member, { kind: 'requeued', why: verdict.why });
      }
      return endWith(batch, progress, 'abandon', verdict.why);
    }
    if (verdict.kind === 'unknown') return endUnknown(batch, built.merged, progress, verdict.why);
    if (verdict.kind === 'red') {
      const again = await retest(host, batch, tested, expected);
      if (!again.green) {
        await split(
          host,
          batch,
          built.merged,
          base.value,
          expected,
          again.checks.length ? again.checks : verdict.checks,
          progress,
        );
        return { done: true };
      }
      progress.flake = true;
      tested = again.sha;
    }
    const now = await queue.stillAsTested(host, built.merged, base.value);
    if (now.baseMoved || now.moved.length > 0) {
      for (const member of now.moved)
        decide(progress, member, { kind: 'requeued', why: 'its head moved' });
      return { done: false, members: built.merged.filter((m) => !now.moved.includes(m)) };
    }
    await landAll(host, batch, built.merged, tested, progress);
    return { done: true };
  }

  /** CI could not say (it did not run, a check could not run, the host failed): nobody is blamed. */
  async function endUnknown(
    batch: FactoryBatch,
    members: QueueMember[],
    progress: Progress,
    why: string,
  ): Promise<{ done: true }> {
    for (const member of members) {
      decide(
        progress,
        member,
        deps.signal.aborted
          ? { kind: 'requeued', why }
          : { kind: 'held', reason: `The merge queue could not test the batch: ${why}.` },
      );
    }
    return endWith(batch, progress, deps.signal.aborted ? 'abandon' : 'fail', why);
  }

  async function endWith(
    batch: FactoryBatch,
    progress: Progress,
    transition: 'abandon' | 'fail',
    summary: string,
  ): Promise<{ done: true }> {
    await deps.batches.move(batch.id, transition, { result: resultOf(progress, summary) });
    return { done: true };
  }

  return {
    /** Lead the batch of `members` (the leader first, then the queue order). */
    async lead(members: QueueMember[]): Promise<BatchOutcome> {
      const progress: Progress = { verdicts: new Map(), flake: false, partialLanding: false };
      let remaining = await eligible(members, progress);
      if (remaining.length === 0)
        return { verdicts: progress.verdicts, result: resultOf(progress, 'No member may merge.') };
      const batch = await startRow(remaining);
      if (!batch) {
        for (const member of remaining)
          decide(progress, member, { kind: 'requeued', why: 'another batch is active' });
        return {
          verdicts: progress.verdicts,
          result: resultOf(progress, 'Another batch is active.'),
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
          batch,
          remaining,
          progress,
          'no check reports on these pull requests, so a batch cannot be tested',
        );
        return {
          verdicts: progress.verdicts,
          result: resultOf(progress, 'No check to test with.'),
        };
      }
      for (let attempt = 1; attempt <= MAX_REBUILDS && remaining.length > 0; attempt++) {
        if (attempt > 1 && !(await deps.batches.rebuild(batch.id, remaining)).unwrapOr(false))
          break;
        const done = await round(host, batch, remaining, expected, progress);
        if (done.done) break;
        remaining = done.members;
      }
      for (const member of remaining)
        decide(progress, member, { kind: 'requeued', why: 'the batch was rebuilt too often' });
      await host.deleteBranch(batch.repo, batch.stagingBranch);
      await host.deleteBranch(batch.repo, batch.queueBranch);
      const ended = await deps.batches.get(batch.id);
      if (ended.isOk() && ended.value && !ended.value.endedAt) {
        await deps.batches.move(batch.id, 'abandon', {
          result: resultOf(progress, 'Rebuilt too often.'),
        });
      }
      log.info('Issue factory batch ended', {
        namespace: 'factory',
        batchId: batch.id,
        repo: batch.repo,
        members: members.length,
        landed: [...progress.verdicts.values()].filter((v) => v.kind === 'merged').length,
      });
      return { verdicts: progress.verdicts, result: resultOf(progress, 'Batch ended.') };
    },
  };
}

/** The failing checks as the culprit's feedback. */
function checksFeedbackOf(checks: FailingCheck[], members: QueueMember[]): string {
  const lines = checks.map((check) =>
    [
      `- ${check.name} (${check.conclusion})`,
      check.excerpt ? `  ${check.excerpt.slice(-2000)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    `Tested with the other pull requests waiting to merge (${members.map((m) => `#${m.prNumber}`).join(', ')}), on the base as it is now, your change makes these checks fail:`,
    ...lines,
    '',
    'Fix it on the branch so your change and the base both pass. Do not disable, skip or weaken tests or checks.',
  ].join('\n');
}
