/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * The steps a merge batch's leader (`factory-batch-leader.ts`) takes that do
 * not recurse into its rounds: holding members, starting the batch row,
 * landing a tested batch, testing a red one again and ending a batch, plus
 * the verdict bookkeeping and the feedback a sent-back member reads.
 */

import type { FailingCheck, IntegrationProvider } from '@funny/core/github-app';

import type { FactoryBatch, FactoryBatchResult } from './factory-batches.js';
import type {
  MemberVerdict,
  MergeQueue,
  MergeQueueDeps,
  QueueMember,
} from './factory-merge-queue.js';

/** What every step of a batch's leader works with. */
export interface BatchLeaderContext {
  queue: MergeQueue;
  deps: MergeQueueDeps;
}

/** The verdicts so far, and the members still in the batch. */
export interface Progress {
  verdicts: Map<string, MemberVerdict>;
  flake: boolean;
  partialLanding: boolean;
}

export const conflictFeedback = (member: QueueMember, others: QueueMember[]) =>
  [
    `Your pull request #${member.prNumber} does not merge onto the base together with the pull requests ahead of it in the queue (${others.map((m) => `#${m.prNumber}`).join(', ') || 'none'}).`,
    'Merge the base branch into your branch, keep both changes, run the tests, commit and push.',
  ].join('\n');

export function resultOf(progress: Progress, summary: string): FactoryBatchResult {
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

/** Record a member's verdict; the first verdict a member gets is final. */
export function decide(progress: Progress, member: QueueMember, verdict: MemberVerdict): void {
  if (!progress.verdicts.has(member.runId)) progress.verdicts.set(member.runId, verdict);
}

/** Members that may not merge their recorded head are held; the rest go on. */
export async function eligible(
  { deps }: BatchLeaderContext,
  members: QueueMember[],
  progress: Progress,
): Promise<QueueMember[]> {
  const kept: QueueMember[] = [];
  for (const member of members) {
    const reason = await deps.hold(member);
    if (reason) decide(progress, member, { kind: 'held', reason });
    else kept.push(member);
  }
  return kept;
}

/** A batch row for the members; a stale one left by a stopped server is ended first. */
export async function startRow(
  { deps }: BatchLeaderContext,
  members: QueueMember[],
): Promise<FactoryBatch | null> {
  const leader = members[0]!;
  const stale = await deps.batches.active(leader.repo, leader.baseBranch);
  if (stale.isOk() && stale.value) {
    // Left by a leader whose server stopped: end it, and remove its branches.
    await deps.batches.move(stale.value.id, 'abandon');
    const host = deps.providerFor(leader);
    await host.deleteBranch(leader.repo, stale.value.stagingBranch);
    await host.deleteBranch(leader.repo, stale.value.queueBranch);
  }
  const started = await deps.batches.start({
    repo: leader.repo,
    baseBranch: leader.baseBranch,
    leaderRunId: leader.runId,
    members,
  });
  return started.isOk() ? started.value : null;
}

/** Land the tested members in order; a refusal after a landing is a partial landing. */
export async function landAll(
  { queue, deps }: BatchLeaderContext,
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
export async function retest(
  { queue, deps }: BatchLeaderContext,
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

/** CI could not say (it did not run, a check could not run, the host failed): nobody is blamed. */
export async function endUnknown(
  ctx: BatchLeaderContext,
  batch: FactoryBatch,
  members: QueueMember[],
  progress: Progress,
  why: string,
): Promise<{ done: true }> {
  for (const member of members) {
    decide(
      progress,
      member,
      ctx.deps.signal.aborted
        ? { kind: 'requeued', why }
        : { kind: 'held', reason: `The merge queue could not test the batch: ${why}.` },
    );
  }
  return endWith(ctx, batch, progress, ctx.deps.signal.aborted ? 'abandon' : 'fail', why);
}

export async function endWith(
  { deps }: BatchLeaderContext,
  batch: FactoryBatch,
  progress: Progress,
  transition: 'abandon' | 'fail',
  summary: string,
): Promise<{ done: true }> {
  await deps.batches.move(batch.id, transition, { result: resultOf(progress, summary) });
  return { done: true };
}

/** The failing checks as the culprit's feedback. */
export function checksFeedbackOf(checks: FailingCheck[], members: QueueMember[]): string {
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
