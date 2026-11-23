/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * A run's `merge` step leading a batch of the merge group (openspec
 * factory-integration D2): the gate gathered the other waiting runs; this
 * resolves them, has the queue test and merge them with the leader, settles
 * each member with its outcome (as the node output its own flow reads:
 * `merge.json.outcome`), and returns the leader's own verdict. Null: no batch
 * here (the branch forbids it, or no member could join), and the leader takes
 * the serial path, every member waiting again.
 */

import type { Batch } from '@funny/pipelines';

import type { MemberVerdict, QueueMember } from './factory-merge-queue.js';
import type { FactoryQueuePort, QueueGates } from './factory-queue-port.js';

/** The run id of a gate holder (`<runId>/<node>/<visit>`). */
const runIdOf = (holder: string) => holder.split('/')[0] ?? holder;

/** A member's verdict as its merge node's output, or how its wait ends. */
async function settleMember(
  queue: FactoryQueuePort,
  batch: Batch,
  member: QueueMember,
  verdict: MemberVerdict | undefined,
): Promise<void> {
  const holder = member.holder!;
  if (!verdict || verdict.kind === 'requeued') {
    batch.settle(holder, { status: 'requeued' });
    return;
  }
  if (verdict.kind === 'merged') {
    await queue.recordMerged(member);
    batch.settle(holder, {
      status: 'succeeded',
      output: { output: 'merged', json: { outcome: 'merged', sha: verdict.sha, batched: true } },
    });
    return;
  }
  if (verdict.kind === 'sent_back') {
    batch.settle(holder, {
      status: 'succeeded',
      output: {
        output: 'sent_back',
        json: { outcome: 'sent_back', why: verdict.why, feedback: verdict.feedback },
      },
    });
    return;
  }
  await queue.recordHeld(member, verdict.reason);
  batch.settle(holder, { status: 'failed', error: `Not merged: ${verdict.reason}.` });
}

/**
 * The members whose changed paths do not overlap the batch so far, in queue
 * order (D11): two changes to the same files are likely to conflict or break
 * each other, so the later one waits for the next batch. A member whose paths
 * are not known is kept.
 */
export function preferDisjoint(self: QueueMember, others: QueueMember[]): QueueMember[] {
  const taken = new Set(self.paths ?? []);
  const kept: QueueMember[] = [];
  for (const member of others) {
    if (member.paths?.some((path) => taken.has(path))) continue;
    for (const path of member.paths ?? []) taken.add(path);
    kept.push(member);
  }
  return kept;
}

export async function mergeAsBatch(input: {
  queue: FactoryQueuePort;
  batch: Batch;
  /** The leader: its own run, at its pull request's head now. */
  self: QueueMember;
  gates: QueueGates;
}): Promise<MemberVerdict | null> {
  const { queue, batch, self } = input;
  const requeueAll = () => {
    for (const member of batch.members) batch.settle(member.holder, { status: 'requeued' });
  };
  if (!(await queue.batchable(self))) {
    requeueAll();
    return null;
  }
  const at = { repo: self.repo, baseBranch: self.baseBranch };
  const others: QueueMember[] = [];
  for (const waiting of batch.members) {
    const member = await queue.memberOf(runIdOf(waiting.holder), waiting.holder, at);
    if (member) others.push(member);
    else batch.settle(waiting.holder, { status: 'requeued' });
  }
  const disjoint = preferDisjoint(self, others);
  for (const member of others) {
    if (!disjoint.includes(member)) batch.settle(member.holder!, { status: 'requeued' });
  }
  if (disjoint.length === 0) return null;
  const left = (member: QueueMember) =>
    batch.members.find((m) => m.holder === member.holder)?.state === 'cancelled';
  const outcome = await queue.lead([self, ...disjoint], input.gates, left);
  for (const member of disjoint) {
    await settleMember(queue, batch, member, outcome.verdicts.get(member.runId));
  }
  return (
    outcome.verdicts.get(self.runId) ?? { kind: 'requeued', why: 'the batch did not decide it' }
  );
}
