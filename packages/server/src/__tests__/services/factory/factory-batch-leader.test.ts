/**
 * The factory's merge queue (openspec factory-integration 4.2, 4.3): a batch
 * tested together in one CI run and merged as tested, each member with its
 * own enabler's token; what happens when the base or a head moves, a member
 * conflicts or leaves, a merge is refused, the tree differs, CI reports
 * nothing; and a red batch re-tested, bisected, or tested one by one.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createBatchLeader } from '../../../services/factory/factory-batch-leader.js';
import { createFactoryBatchesRepository } from '../../../services/factory/factory-batches.js';
import {
  createMergeQueue,
  type MemberVerdict,
  type MergeQueueDeps,
  type QueueMember,
} from '../../../services/factory/factory-merge-queue.js';
import {
  createFakeHost,
  type FakeHost,
  type FakeHostOptions,
} from '../../helpers/fake-integration.js';
import { createTestDb } from '../../helpers/test-db.js';

beforeEach(async () => {
  const testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
});

/** Members #1..#n, each the run `r<n>` of enabler `users[i]` (default alice), head `h<n>`. */
function members(host: FakeHost, n: number, users: string[] = []): QueueMember[] {
  return Array.from({ length: n }, (_, i) => {
    const number = i + 1;
    host.heads.set(number, `h${number}`);
    return {
      holder: i === 0 ? null : `r${number}/merge/0`,
      runId: `r${number}`,
      factoryId: 'f1',
      userId: users[i] ?? 'alice',
      projectId: 'p1',
      prNumber: number,
      headSha: `h${number}`,
      repo: 'o/r',
      baseBranch: 'main',
      method: 'squash' as const,
    };
  });
}

async function lead(
  n: number,
  options: FakeHostOptions & {
    users?: string[];
    hold?: (member: QueueMember) => string | null;
    deps?: Partial<MergeQueueDeps>;
  } = {},
) {
  const host = createFakeHost(options);
  const list = members(host, n, options.users);
  const batches = createFactoryBatchesRepository();
  const deps: MergeQueueDeps = {
    batches,
    providerFor: (member) => host.as(member.userId),
    hold: async (member) => options.hold?.(member) ?? null,
    signal: new AbortController().signal,
    pollMs: 1,
    noChecksGraceMs: 0,
    ...options.deps,
  };
  const outcome = await createBatchLeader(createMergeQueue(deps), deps).lead(list);
  const kind = (runId: string) => outcome.verdicts.get(runId)?.kind;
  const batch = (await batches.active('o/r', 'main'))._unsafeUnwrap();
  return { host, outcome, kind, batches, activeBatch: batch };
}

const kinds = (verdicts: Map<string, MemberVerdict>) =>
  Object.fromEntries([...verdicts].map(([runId, v]) => [runId, v.kind]));

describe('a green batch', () => {
  test('three pull requests are tested in one CI run and merged in order', async () => {
    const { host, outcome } = await lead(3);
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'merged', r3: 'merged' });
    expect(host.merged.map((m) => m.number)).toEqual([1, 2, 3]);
    // One commit was tested for the whole batch.
    expect(host.checked.size).toBe(1);
    // The staging merges never trigger CI; the queue branch is gone afterwards.
    expect(host.stagingMessages.every((message) => message.includes('[skip ci]'))).toBe(true);
    expect([...host.branches.keys()].filter((b) => b.startsWith('factory/'))).toEqual([]);
    expect(host.contentOf(host.branches.get('main')!)).toEqual(['h1', 'h2', 'h3']);
  });

  test('members of two enablers are each merged with their own token', async () => {
    const { host } = await lead(2, { users: ['alice', 'bob'] });
    expect(host.merged.map((m) => [m.number, m.userId])).toEqual([
      [1, 'alice'],
      [2, 'bob'],
    ]);
  });

  test('the base moved while CI ran: rebuilt on the new base, then merged', async () => {
    let moved = false;
    const { host, outcome } = await lead(2, {
      afterCheck: (h) => {
        if (moved) return;
        moved = true;
        h.push('main', 'other');
      },
    });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'merged' });
    expect(host.checked.size).toBe(2);
    expect(host.contentOf(host.branches.get('main')!)).toEqual(['h1', 'h2', 'other']);
  });

  test('a member whose head moved leaves; the others are rebuilt and merged', async () => {
    let pushed = false;
    const { host, outcome } = await lead(3, {
      afterCheck: (h) => {
        if (pushed) return;
        pushed = true;
        h.heads.set(2, 'h2-new');
      },
    });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'requeued', r3: 'merged' });
    expect(host.merged.map((m) => m.number)).toEqual([1, 3]);
  });

  test('a member whose run was stopped leaves before anything merges', async () => {
    const { host, outcome } = await lead(2, {
      deps: { left: (member) => member.runId === 'r2' },
    });
    expect(kinds(outcome.verdicts)).toMatchObject({ r1: 'merged', r2: 'requeued' });
    expect(host.merged.map((m) => m.number)).toEqual([1]);
  });

  test('a member that conflicts with the batch goes back to its loop; the rest merge', async () => {
    const { host, outcome } = await lead(3, { conflicts: new Set(['h2']) });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'sent_back', r3: 'merged' });
    expect(outcome.verdicts.get('r2')).toMatchObject({ why: 'conflict' });
    expect(host.merged.map((m) => m.number)).toEqual([1, 3]);
  });

  test('a member that may not merge (no passing review for its head) is held, not tested', async () => {
    const { outcome } = await lead(2, {
      hold: (member) => (member.runId === 'r2' ? 'no review' : null),
    });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'held' });
  });

  test('a merge refused after the first landed: a partial landing, the rest wait again', async () => {
    const { host, outcome, batches } = await lead(3, { refuse: new Set([2]) });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'requeued', r3: 'requeued' });
    expect(host.merged.map((m) => m.number)).toEqual([1]);
    expect(outcome.result.partialLanding).toBe(true);
    expect((await batches.active('o/r', 'main'))._unsafeUnwrap()).toBeNull();
  });

  test('a base whose tree is not the tested one after the merges is reported', async () => {
    const mismatches: string[][] = [];
    let landedOnce = false;
    const host = createFakeHost();
    // Someone pushes right after the first merge.
    const provider = host.as('alice');
    const pushing = {
      ...provider,
      mergePullRequest: (repo: string, number: number, input: { sha: string; method: 'squash' }) =>
        provider.mergePullRequest(repo, number, input).map((merged) => {
          if (!landedOnce) {
            landedOnce = true;
            host.push('main', 'intruder');
          }
          return merged;
        }),
    };
    const list = members(host, 2);
    const deps: MergeQueueDeps = {
      batches: createFactoryBatchesRepository(),
      providerFor: () => pushing,
      hold: async () => null,
      signal: new AbortController().signal,
      pollMs: 1,
      noChecksGraceMs: 0,
      onTreeMismatch: async (_batch, landed) => {
        mismatches.push(landed);
      },
    };
    await createBatchLeader(createMergeQueue(deps), deps).lead(list);
    expect(mismatches).toEqual([['r1', 'r2']]);
  });

  test('no check reported on the queue branch: nothing merges and nobody is blamed', async () => {
    const { host, outcome } = await lead(2, { ci: () => 'none' });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'held', r2: 'held' });
    expect(outcome.verdicts.get('r1')).toMatchObject({
      reason: expect.stringContaining('CI did not run on the queue branch'),
    });
    expect(host.merged).toEqual([]);
  });

  test('a stopped leader merges nothing; its members wait again', async () => {
    const controller = new AbortController();
    controller.abort();
    const { host, outcome } = await lead(2, {
      ci: () => 'pending',
      deps: { signal: controller.signal },
    });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'requeued', r2: 'requeued' });
    expect(host.merged).toEqual([]);
  });
});

describe('a red batch', () => {
  const culprit =
    (...bad: string[]) =>
    (content: string[]) =>
      bad.some((head) => content.includes(head)) ? ('red' as const) : ('green' as const);

  test.each([['h1'], ['h2'], ['h3'], ['h4']])(
    'a culprit at %s is isolated and sent back with the failure; the rest wait again',
    async (bad) => {
      const { host, outcome } = await lead(4, { ci: culprit(bad) });
      const runId = `r${bad.slice(1)}`;
      expect(outcome.verdicts.get(runId)).toMatchObject({ kind: 'sent_back', why: 'checks' });
      expect(String((outcome.verdicts.get(runId) as { feedback: string }).feedback)).toContain(
        'test (failure)',
      );
      for (const other of ['r1', 'r2', 'r3', 'r4'].filter((id) => id !== runId)) {
        expect(outcome.verdicts.get(other)?.kind).toBe('requeued');
      }
      // Nothing merges on the strength of halves tested apart.
      expect(host.merged).toEqual([]);
    },
  );

  test('two culprits are both found', async () => {
    const { outcome } = await lead(4, { ci: culprit('h1', 'h4') });
    expect(kinds(outcome.verdicts)).toEqual({
      r1: 'sent_back',
      r2: 'requeued',
      r3: 'requeued',
      r4: 'sent_back',
    });
  });

  test('a red that turns green on the same tree is a flake: the batch merges', async () => {
    const { host, outcome } = await lead(2, {
      ci: (_content, times) => (times === 1 ? 'red' : 'green'),
    });
    expect(kinds(outcome.verdicts)).toEqual({ r1: 'merged', r2: 'merged' });
    expect(host.merged.map((m) => m.number)).toEqual([1, 2]);
  });

  test('a failure only two members cause together: one by one, the second is the culprit', async () => {
    const clash = (content: string[]) =>
      content.includes('h1') && content.includes('h3') ? ('red' as const) : ('green' as const);
    const { host, outcome } = await lead(4, { ci: clash });
    // h1 and h3 are in different halves, so no half is red: each is tested
    // alone on the base as it is, the green ones land in order, and h3 is red
    // once h1 is on the base.
    expect(kinds(outcome.verdicts)).toEqual({
      r1: 'merged',
      r2: 'merged',
      r3: 'sent_back',
      r4: 'merged',
    });
    expect(host.merged.map((m) => m.number)).toEqual([1, 2, 4]);
  });

  test('a red batch of one is that member’s failure', async () => {
    const { outcome } = await lead(1, { ci: () => 'red' });
    expect(outcome.verdicts.get('r1')).toMatchObject({ kind: 'sent_back', why: 'checks' });
  });
});
