/**
 * A run's `merge` leading a batch (openspec factory-integration 4.2, 4.4,
 * 4.4b): each member settled with the output its own flow reads, and the
 * rules that keep a base branch on the serial path: GitHub's merge queue when
 * it is required (read per batch), and branches that must be up to date
 * (read from the rules, or learned from a refused merge).
 */
import { describe, expect, test } from 'bun:test';

import type { BranchRules } from '@funny/core/github-app';
import type { Batch, MemberOutcome } from '@funny/pipelines';

import { createFactoryBatchesRepository } from '../../../services/factory/factory-batches.js';
import { mergeAsBatch } from '../../../services/factory/factory-merge-batch.js';
import type { MemberVerdict, QueueMember } from '../../../services/factory/factory-merge-queue.js';
import {
  createFactoryQueuePort,
  type FactoryQueuePort,
} from '../../../services/factory/factory-queue-port.js';
import { createFakeHost } from '../../helpers/fake-integration.js';
import { createTestDb } from '../../helpers/test-db.js';

const member = (n: number, holder: string | null): QueueMember => ({
  holder,
  runId: `r${n}`,
  factoryId: 'f1',
  userId: 'alice',
  projectId: 'p1',
  prNumber: n,
  headSha: `h${n}`,
  repo: 'o/r',
  baseBranch: 'main',
  method: 'squash',
});

/** A gate's batch of the members `r2..` that records how each was settled. */
function gateBatch(n: number) {
  const settled = new Map<string, MemberOutcome>();
  const batch: Batch = {
    members: Array.from({ length: n }, (_, i) => ({
      holder: `r${i + 2}/merge/1`,
      input: {},
      state: 'pending' as const,
    })),
    settle: (holder, outcome) => {
      settled.set(holder, outcome);
    },
  };
  return { batch, settled };
}

/** A queue whose batch ends with `verdicts`, recording what it wrote on the runs. */
function fakeQueue(verdicts: Record<string, MemberVerdict>, batchable = true) {
  const written: string[] = [];
  const queue: FactoryQueuePort = {
    memberOf: async (runId, holder) => member(Number(runId.slice(1)), holder),
    batchable: async () => batchable,
    lead: async () => ({
      verdicts: new Map(Object.entries(verdicts)),
      result: {
        summary: '',
        landed: [],
        culprits: [],
        requeued: [],
        flake: false,
        partialLanding: false,
      },
      stats: { size: 5, attempts: 2, durationMs: 1000 },
    }),
    recordMerged: async (m) => {
      written.push(`merged ${m.runId}`);
    },
    deleteMergedBranch: async () => undefined,
    recordStats: async (m) => {
      written.push(`stats ${m.runId}`);
    },
    recordHeld: async (m, reason) => {
      written.push(`held ${m.runId}: ${reason}`);
    },
  };
  return { queue, written };
}

const gates = { requireReview: true, requireRegressionProof: true };

describe('mergeAsBatch', () => {
  test('each member is settled with the outcome its merge step would have had', async () => {
    const { batch, settled } = gateBatch(4);
    const { queue, written } = fakeQueue({
      r1: { kind: 'merged', sha: 'L1' },
      r2: { kind: 'merged', sha: 'L2' },
      r3: { kind: 'sent_back', why: 'checks', feedback: 'test fails' },
      r4: { kind: 'held', reason: 'no review' },
      r5: { kind: 'requeued', why: 'head moved' },
    });
    const own = await mergeAsBatch({ queue, batch, self: member(1, null), gates });
    expect(own).toEqual({ kind: 'merged', sha: 'L1' });
    expect(settled.get('r2/merge/1')).toEqual({
      status: 'succeeded',
      output: { output: 'merged', json: { outcome: 'merged', sha: 'L2', batched: true } },
    });
    // The member's merge loop reads `merge.json.outcome = "sent_back"`.
    expect(settled.get('r3/merge/1')).toEqual({
      status: 'succeeded',
      output: {
        output: 'sent_back',
        json: { outcome: 'sent_back', why: 'checks', feedback: 'test fails' },
      },
    });
    expect(settled.get('r4/merge/1')).toEqual({
      status: 'failed',
      error: 'Not merged: no review.',
    });
    expect(settled.get('r5/merge/1')).toEqual({ status: 'requeued' });
    expect(written).toEqual([
      'stats r2',
      'merged r2',
      'stats r3',
      'stats r4',
      'held r4: no review',
      'stats r5',
    ]);
  });

  test('a branch that does not allow batches: every member waits again, the leader goes serial', async () => {
    const { batch, settled } = gateBatch(2);
    const { queue } = fakeQueue({ r1: { kind: 'merged', sha: 'L1' } }, false);
    expect(await mergeAsBatch({ queue, batch, self: member(1, null), gates })).toBeNull();
    expect([...settled.values()]).toEqual([{ status: 'requeued' }, { status: 'requeued' }]);
  });
});

describe('which base branches batch', () => {
  /** A port over a host whose rules are `rules()` now. */
  function port(rules: () => BranchRules) {
    const host = createFakeHost({ rules });
    return createFactoryQueuePort({
      batches: createFactoryBatchesRepository(),
      run: async () => null,
      factory: async () => null,
      record: async () => undefined,
      integrationFor: (owner) => host.as(owner.userId),
      signal: new AbortController().signal,
    });
  }
  const open: BranchRules = { mergeQueue: false, requiredChecks: [], upToDate: null };

  test("GitHub's merge queue, read per batch: once required, it is used instead", async () => {
    let rules = open;
    const queue = port(() => rules);
    const leader = { ...member(1, null), repo: 'o/queue-switch' };
    expect(await queue.batchable(leader)).toBe(true);
    rules = { ...open, mergeQueue: true };
    expect(await queue.batchable(leader)).toBe(false);
  });

  test('a repository whose CI does not run on the queue branches keeps the serial path', async () => {
    const host = createFakeHost();
    const portWith = (workflows: string[] | null) =>
      createFactoryQueuePort({
        batches: createFactoryBatchesRepository(),
        run: async () => null,
        factory: async () => null,
        record: async () => undefined,
        integrationFor: (owner) => host.as(owner.userId),
        workflows: async () => workflows,
        signal: new AbortController().signal,
      });
    const prOnly = 'on:\n  pull_request:\n  push:\n    branches: [main]\n';
    expect(await portWith([prOnly]).batchable({ ...member(1, null), repo: 'o/pr-only' })).toBe(
      false,
    );
    expect(await portWith(null).batchable({ ...member(1, null), repo: 'o/unreadable' })).toBe(
      false,
    );
    expect(await portWith(['on: push\n']).batchable({ ...member(1, null), repo: 'o/push' })).toBe(
      true,
    );
  });

  test('a branch that requires pull requests to be up to date gets batches of one', async () => {
    const queue = port(() => ({ ...open, upToDate: true }));
    expect(await queue.batchable({ ...member(1, null), repo: 'o/strict' })).toBe(false);
  });

  test('an unreadable up-to-date rule is learned from a partial landing and remembered', async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    // GitHub refuses #2 after #1 landed: what a branch that must be up to date does.
    const host = createFakeHost({ refuse: new Set([2]) });
    const members = [1, 2].map((n) => {
      host.heads.set(n, `h${n}`);
      return { ...member(n, n === 1 ? null : `r${n}/merge/1`), repo: 'o/learned' };
    });
    const queue = createFactoryQueuePort({
      batches: createFactoryBatchesRepository(),
      run: async () =>
        ({ factoryId: 'f1', reviews: [], risk: null, regressionProof: null }) as never,
      factory: async () => null,
      record: async () => undefined,
      integrationFor: (owner) => host.as(owner.userId),
      signal: new AbortController().signal,
      pollMs: 1,
    });
    expect(await queue.batchable(members[0]!)).toBe(true);
    const outcome = await queue.lead(
      members,
      { requireReview: false, requireRegressionProof: false },
      () => false,
    );
    expect(outcome.result.partialLanding).toBe(true);
    expect(await queue.batchable(members[0]!)).toBe(false);
  });

  // Found in the E2E: the agent left the culprit as it was, and it was batched again.
  test('a commit isolated as the cause of a red batch, back unchanged, waits for a person', async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    const batches = createFactoryBatchesRepository();
    const repo = 'o/culprit';
    const culprit = { ...member(1, null), repo };
    const other = { ...member(2, 'r2/merge/1'), repo };
    // An earlier batch named r1 at h1 the culprit.
    const earlier = (
      await batches.start({
        repo,
        baseBranch: 'main',
        leaderRunId: 'r1',
        members: [culprit, other],
      })
    )._unsafeUnwrap()!;
    await batches.move(earlier.id, 'test');
    await batches.move(earlier.id, 'retest');
    await batches.move(earlier.id, 'bisect');
    await batches.move(earlier.id, 'split', {
      result: {
        summary: 'Red batch of 2: bisected.',
        landed: [],
        culprits: ['r1'],
        requeued: ['r2'],
        flake: false,
        partialLanding: false,
      },
    });
    expect((await batches.culpritAt(repo, 'r1', 'h1'))._unsafeUnwrap()).toBe(true);
    // A new commit is a new change: it may be batched again.
    expect((await batches.culpritAt(repo, 'r1', 'h1-fixed'))._unsafeUnwrap()).toBe(false);
    expect((await batches.culpritAt(repo, 'r2', 'h2'))._unsafeUnwrap()).toBe(false);

    const host = createFakeHost();
    host.heads.set(1, 'h1');
    host.heads.set(2, 'h2');
    const queue = createFactoryQueuePort({
      batches,
      run: async () =>
        ({ factoryId: 'f1', reviews: [], risk: null, regressionProof: null }) as never,
      factory: async () => null,
      record: async () => undefined,
      integrationFor: (owner) => host.as(owner.userId),
      signal: new AbortController().signal,
      pollMs: 1,
    });
    const outcome = await queue.lead(
      [culprit, other],
      { requireReview: false, requireRegressionProof: false },
      () => false,
    );
    expect(outcome.verdicts.get('r1')).toEqual({
      kind: 'held',
      reason: expect.stringContaining('made a merge queue batch fail before'),
    });
    expect(outcome.verdicts.get('r2')?.kind).toBe('merged');
  });
});
