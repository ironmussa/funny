/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * The factory's merge queue (openspec factory-integration D2-D3): the leader
 * of a batch tests its members together, on the base as it is, in about one
 * CI run, and merges them only as they were tested.
 *
 * 1. Build: from base commit B, merge each member's recorded head onto the
 *    staging branch (`[skip ci]` commits), then point the queue branch at a
 *    commit with the same tree, which CI tests once. A member that does not
 *    merge onto the batch so far is sent back (its loop goes to `integrate`).
 * 2. Verdict: the base's required checks, or every check that reported on
 *    the members' heads, must pass. No expected check is never green.
 * 3. Green: if the base is still B and no head moved, merge the members in
 *    order, each with its own enabler's token, pinned to the tested head; then
 *    compare the base's tree with the tested one. A refusal after a member
 *    landed is a partial landing: the rest wait again.
 * 4. Red: test the same tree once more (a flake?), then bisect: halves from B
 *    in parallel, every red half split again; culprits are sent back with the
 *    failure, the rest wait again. No red half: batches of one, in order.
 *
 * Every write about a member uses that member's enabler's capped token
 * (`providerFor`); the batch branches use the leader's.
 */

import type {
  CiState,
  FailingCheck,
  IntegrationProvider,
  MergeMethod,
} from '@funny/core/github-app';
import { sleep as interruptibleSleep } from '@funny/shared/async';

import { log } from '../../lib/logger.js';
import type {
  FactoryBatch,
  FactoryBatchMember,
  FactoryBatchResult,
  FactoryBatchesRepository,
} from './factory-batches.js';

/** A run in the batch, as the leader sees it. */
export interface QueueMember extends FactoryBatchMember {
  /** The gate's holder of a member; null for the leader (its result is returned, not settled). */
  holder: string | null;
  repo: string;
  baseBranch: string;
  method: MergeMethod;
  /** The paths its head changes, when known (batches prefer members with disjoint ones, D11). */
  paths?: string[];
}

/** What happened to one member. */
export type MemberVerdict =
  /** Landed: its pull request merged as commit `sha`. */
  | { kind: 'merged'; sha: string }
  /** Back to its implementer's loop: a conflict onto the batch, or the checks it breaks. */
  | { kind: 'sent_back'; why: 'conflict' | 'checks'; feedback: string }
  /** It may not merge now (no passing review for its head, high risk, no proof, refused): a person looks. */
  | { kind: 'held'; reason: string }
  /** Not decided by this batch: it waits in the queue again. */
  | { kind: 'requeued'; why: string };

export interface MergeQueueDeps {
  batches: FactoryBatchesRepository;
  /** The host, with `userId`'s enabler-capped token for the run's repository. */
  providerFor(member: Pick<QueueMember, 'userId' | 'projectId'>): IntegrationProvider;
  /** Why `member` may not merge its recorded head, or null when it may (review, risk, proof). */
  hold(member: QueueMember): Promise<string | null>;
  signal: AbortSignal;
  /** How often CI on a queue branch is looked at (tests shorten it). */
  pollMs?: number;
  /** How long CI may take on a queue branch. */
  ciTimeoutMs?: number;
  /** How long a queue branch may have no check at all before CI is said not to run there. */
  noChecksGraceMs?: number;
  /** CI never ran on a queue branch of `repo`: its batches stop until it does (D12). */
  onNoQueueCi?(repo: string): void;
  /** Whether a member left the batch (its run was stopped or taken over). */
  left?(member: QueueMember): boolean;
  /** A base whose tree is not the tested one after the merges (someone pushed in between). */
  onTreeMismatch?(batch: FactoryBatch, landed: string[]): Promise<void>;
}

const POLL_MS = 15_000;
const CI_TIMEOUT_MS = 60 * 60_000;
const NO_CHECKS_GRACE_MS = 5 * 60_000;
/** Rebuilds of one batch (the base moved, a head moved) before its members wait again. */
const MAX_REBUILDS = 3;

const prList = (members: QueueMember[]) => members.map((m) => `#${m.prNumber}`).join(', ');

/** How an attempt ends for each verdict of its commit. */
const ATTEMPT_END = { green: 'green', red: 'red', unknown: 'abandoned' } as const;

/** A CI verdict once it is known: green, red with its checks, or why it is not known. */
type Verdict =
  | { kind: 'green' }
  | { kind: 'red'; checks: FailingCheck[] }
  /** `noCi`: no check ever reported on the queue branch (CI does not run there). */
  | { kind: 'unknown'; why: string; noCi?: boolean };

function verdictOf(ci: CiState): Verdict | null {
  if (ci.kind === 'green') return { kind: 'green' };
  if (ci.kind === 'failing') return { kind: 'red', checks: ci.checks };
  if (ci.kind === 'blocked')
    return { kind: 'unknown', why: 'a check could not run on the queue branch' };
  return null;
}

export function createMergeQueue(deps: MergeQueueDeps) {
  const pollMs = deps.pollMs ?? POLL_MS;
  const ciTimeoutMs = deps.ciTimeoutMs ?? CI_TIMEOUT_MS;
  const noChecksGraceMs = deps.noChecksGraceMs ?? NO_CHECKS_GRACE_MS;

  /** Wait for the verdict of `sha`'s `expected` checks. Pending past the timeout, or none: unknown. */
  async function waitVerdict(
    host: IntegrationProvider,
    repo: string,
    sha: string,
    expected: string[],
  ): Promise<Verdict> {
    const started = Date.now();
    while (!deps.signal.aborted) {
      const ci = await host.checks(repo, sha, expected);
      if (ci.isOk()) {
        const verdict = verdictOf(ci.value);
        if (verdict) return verdict;
        const waited = Date.now() - started;
        if (ci.value.kind === 'none' && waited > noChecksGraceMs) {
          return { kind: 'unknown', why: 'CI did not run on the queue branch', noCi: true };
        }
        if (waited > ciTimeoutMs)
          return { kind: 'unknown', why: 'CI did not finish on the queue branch' };
      }
      await interruptibleSleep(pollMs, deps.signal).catch(() => undefined);
    }
    return { kind: 'unknown', why: 'the run was stopped' };
  }

  /** The checks a batch commit must pass: the base's required ones, else those the members' heads reported. */
  async function expectedChecks(
    host: IntegrationProvider,
    members: QueueMember[],
    required: string[],
  ): Promise<string[]> {
    if (required.length > 0) return required;
    const names = new Set<string>();
    for (const member of members) {
      const reported = await deps.providerFor(member).checkNames(member.repo, member.headSha);
      if (reported.isOk()) for (const name of reported.value) names.add(name);
    }
    return [...names];
  }

  /**
   * Merge `members`' heads onto `staging` from `base`, then point `queue` at a
   * commit with the same tree. Members that conflict are returned apart.
   */
  async function build(
    host: IntegrationProvider,
    members: QueueMember[],
    branches: { staging: string; queue: string; label: string },
    base: string,
  ): Promise<
    { sha: string; merged: QueueMember[]; conflicted: QueueMember[] } | { error: string }
  > {
    const repo = members[0]!.repo;
    const reset = await host.setBranch(repo, branches.staging, base);
    if (reset.isErr()) return { error: reset.error.message };
    const merged: QueueMember[] = [];
    const conflicted: QueueMember[] = [];
    let head = base;
    for (const member of members) {
      const result = await host.mergeRefInto(
        repo,
        branches.staging,
        member.headSha,
        `Merge #${member.prNumber} into ${branches.label} [skip ci]`,
      );
      if (result.isErr()) return { error: result.error.message };
      if (result.value.kind === 'conflict') conflicted.push(member);
      else {
        merged.push(member);
        if (result.value.kind === 'merged') head = result.value.sha;
      }
    }
    if (merged.length === 0) return { sha: base, merged, conflicted };
    const tested = await host.sameTreeCommit(repo, head, `${branches.label}: ${prList(merged)}`);
    if (tested.isErr()) return { error: tested.error.message };
    const pointed = await host.setBranch(repo, branches.queue, tested.value);
    if (pointed.isErr()) return { error: pointed.error.message };
    return { sha: tested.value, merged, conflicted };
  }

  /** Test `members` from `base` on their own branches; the verdict. */
  async function testApart(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    base: string,
    expected: string[],
    label: string,
  ): Promise<{ verdict: Verdict; members: QueueMember[]; conflicted: QueueMember[] }> {
    const branches = {
      staging: `${batch.stagingBranch}-${label}`,
      queue: `${batch.queueBranch}-${label}`,
      label: `Batch ${batch.id} (${label})`,
    };
    const attempt = await deps.batches.addAttempt(
      batch.id,
      members.map((m) => m.runId),
      branches.queue,
    );
    const built = await build(host, members, branches, base);
    const cleanup = async () => {
      await host.deleteBranch(batch.repo, branches.staging);
      await host.deleteBranch(batch.repo, branches.queue);
    };
    if ('error' in built) {
      if (attempt.isOk()) await deps.batches.endAttempt(attempt.value.id, 'abandoned');
      await cleanup();
      return { verdict: { kind: 'unknown', why: built.error }, members, conflicted: [] };
    }
    if (attempt.isOk()) await deps.batches.attemptSha(attempt.value.id, built.sha);
    const verdict = await waitVerdict(host, batch.repo, built.sha, expected);
    if (attempt.isOk()) {
      const end = ATTEMPT_END[verdict.kind];
      await deps.batches.endAttempt(
        attempt.value.id,
        end,
        verdict.kind === 'red' ? verdict.checks : undefined,
      );
    }
    await cleanup();
    return { verdict, members: built.merged, conflicted: built.conflicted };
  }

  /**
   * Bisect a red batch: halves from `base`, in parallel, every red half split
   * again. The culprits (red halves of one) and the members cleared by it.
   */
  async function bisect(
    host: IntegrationProvider,
    batch: FactoryBatch,
    members: QueueMember[],
    base: string,
    expected: string[],
    failing: FailingCheck[],
    label = 'h',
  ): Promise<{
    culprits: Map<string, FailingCheck[]>;
    conflicted: QueueMember[];
    anyRed: boolean;
  }> {
    const culprits = new Map<string, FailingCheck[]>();
    if (members.length === 1) {
      culprits.set(members[0]!.runId, failing);
      return { culprits, conflicted: [], anyRed: true };
    }
    const middle = Math.ceil(members.length / 2);
    const halves = [members.slice(0, middle), members.slice(middle)];
    const tested = await Promise.all(
      halves.map((half, index) => testApart(host, batch, half, base, expected, `${label}${index}`)),
    );
    const conflicted: QueueMember[] = tested.flatMap((t) => t.conflicted);
    let anyRed = false;
    for (const [index, result] of tested.entries()) {
      if (result.verdict.kind !== 'red') continue;
      anyRed = true;
      const deeper = await bisect(
        host,
        batch,
        result.members,
        base,
        expected,
        result.verdict.checks,
        `${label}${index}`,
      );
      for (const [runId, checks] of deeper.culprits) culprits.set(runId, checks);
      conflicted.push(...deeper.conflicted);
    }
    return { culprits, conflicted, anyRed };
  }

  /** Whether the base is still `base` and every member's head is the one tested; the members that left. */
  async function stillAsTested(
    host: IntegrationProvider,
    members: QueueMember[],
    base: string,
  ): Promise<{ baseMoved: boolean; moved: QueueMember[] }> {
    const repo = members[0]!.repo;
    const head = await host.branchHead(repo, members[0]!.baseBranch);
    const moved: QueueMember[] = [];
    for (const member of members) {
      const pr = await deps.providerFor(member).pullRequestMergeability(repo, member.prNumber);
      const gone = deps.left?.(member) ?? false;
      if (gone || pr.isErr() || pr.value.state !== 'open' || pr.value.headSha !== member.headSha) {
        moved.push(member);
      }
    }
    return { baseMoved: head.isErr() || head.value !== base, moved };
  }

  /** Merge the tested members in order, each with its own token, pinned to its head. */
  async function land(members: QueueMember[]): Promise<{
    landed: Array<{ member: QueueMember; sha: string }>;
    refused: { member: QueueMember; reason: string } | null;
  }> {
    const landed: Array<{ member: QueueMember; sha: string }> = [];
    for (const member of members) {
      const merged = await deps.providerFor(member).mergePullRequest(member.repo, member.prNumber, {
        sha: member.headSha,
        method: member.method,
      });
      if (merged.isErr()) return { landed, refused: { member, reason: merged.error.message } };
      if (merged.value.kind === 'refused') {
        return { landed, refused: { member, reason: merged.value.reason } };
      }
      landed.push({ member, sha: merged.value.sha });
    }
    return { landed, refused: null };
  }

  /** After the merges: the base's tree must be the tested one. */
  async function checkTree(
    host: IntegrationProvider,
    batch: FactoryBatch,
    testedSha: string,
    landed: string[],
  ): Promise<void> {
    const head = await host.branchHead(batch.repo, batch.baseBranch);
    if (head.isErr()) return;
    const [now, tested] = [
      await host.treeOf(batch.repo, head.value),
      await host.treeOf(batch.repo, testedSha),
    ];
    if (now.isErr() || tested.isErr() || now.value === tested.value) return;
    log.warn('Issue factory batch: the base is not what was tested', {
      namespace: 'factory',
      batchId: batch.id,
      repo: batch.repo,
    });
    await deps.onTreeMismatch?.(batch, landed);
  }

  return { build, waitVerdict, expectedChecks, bisect, stillAsTested, land, checkTree, testApart };
}

export type MergeQueue = ReturnType<typeof createMergeQueue>;

/** The verdicts of a batch, by run id, and how the batch row ends. */
export interface BatchOutcome {
  verdicts: Map<string, MemberVerdict>;
  result: FactoryBatchResult;
  /** What the batch cost, for every member's counters (D13). */
  stats: BatchStats;
}

export interface BatchStats {
  /** Members it started with, the leader included. */
  size: number;
  /** Halves tested apart while bisecting. */
  attempts: number;
  durationMs: number;
}

export { MAX_REBUILDS };
