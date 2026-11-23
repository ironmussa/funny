/**
 * The merge queue's order (openspec factory-integration 4.5, D11): a blocker
 * first, a much smaller change before a large one, admission order otherwise;
 * a batch prefers members whose changed paths do not overlap; a regenerable
 * run never joins a batch.
 */
import { describe, expect, test } from 'bun:test';

import { createFactoryBatchesRepository } from '../../../services/factory/factory-batches.js';
import { mergePriority } from '../../../services/factory/factory-flow-runs.js';
import { preferDisjoint } from '../../../services/factory/factory-merge-batch.js';
import type { QueueMember } from '../../../services/factory/factory-merge-queue.js';
import { createFactoryQueuePort } from '../../../services/factory/factory-queue-port.js';
import { createFakeHost } from '../../helpers/fake-integration.js';

/** Waiters in the order the gate grants them: ascending priority. */
const order = (runs: Record<string, number>) =>
  Object.entries(runs)
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name);

describe('merge priority', () => {
  test('a blocker goes first, whatever its size and admission', () => {
    expect(
      order({
        early: mergePriority(100, { blocker: false, lines: 10 }),
        blocker: mergePriority(900, { blocker: true, lines: 5_000 }),
      }),
    ).toEqual(['blocker', 'early']);
  });

  test('a much smaller change goes before a large one admitted earlier', () => {
    expect(
      order({
        refactor: mergePriority(100, { blocker: false, lines: 2_000 }),
        fix: mergePriority(900, { blocker: false, lines: 12 }),
      }),
    ).toEqual(['fix', 'refactor']);
  });

  test('changes of a similar size keep admission order', () => {
    expect(
      order({
        second: mergePriority(900, { blocker: false, lines: 40 }),
        first: mergePriority(100, { blocker: false, lines: 60 }),
      }),
    ).toEqual(['first', 'second']);
  });

  test('a change whose size is not known yet is ordered as a small one, by admission', () => {
    expect(
      order({
        unknown: mergePriority(100, { blocker: false }),
        big: mergePriority(50, { blocker: false, lines: 500 }),
      }),
    ).toEqual(['unknown', 'big']);
  });
});

const member = (n: number, paths?: string[]): QueueMember => {
  const queued: QueueMember = {
    holder: n === 1 ? null : `r${n}/merge/1`,
    runId: `r${n}`,
    factoryId: 'f1',
    userId: 'alice',
    projectId: 'p1',
    prNumber: n,
    headSha: `h${n}`,
    repo: 'o/r',
    baseBranch: 'main',
    method: 'squash',
  };
  if (paths) queued.paths = paths;
  return queued;
};

describe('disjoint batches', () => {
  test('a member touching a file another member changes waits for the next batch', () => {
    const kept = preferDisjoint(member(1, ['src/a.ts']), [
      member(2, ['src/a.ts', 'src/b.ts']),
      member(3, ['src/c.ts']),
      member(4, ['src/c.ts']),
      member(5),
    ]);
    expect(kept.map((m) => m.runId)).toEqual(['r3', 'r5']);
  });
});

describe('regenerable runs', () => {
  test('a run whose merge regenerates its change does not join a batch', async () => {
    const host = createFakeHost();
    host.heads.set(2, 'h2');
    const run = (regenerateNode: string | null) =>
      ({
        id: 'r2',
        factoryId: 'f1',
        prUrl: 'https://github.com/o/r/pull/2',
        reviews: [],
        risk: null,
        regressionProof: null,
        regenerateNode,
      }) as never;
    const portFor = (regenerateNode: string | null) =>
      createFactoryQueuePort({
        batches: createFactoryBatchesRepository(),
        run: async () => run(regenerateNode),
        factory: async () =>
          ({ id: 'f1', userId: 'alice', projectId: 'p1', autoMerge: 'low_risk' }) as never,
        record: async () => undefined,
        integrationFor: (owner) => host.as(owner.userId),
        signal: new AbortController().signal,
      });
    const at = { repo: 'o/r', baseBranch: 'main' };
    expect(await portFor(null).memberOf('r2', 'r2/merge/1', at)).toMatchObject({ prNumber: 2 });
    expect(await portFor('codemod').memberOf('r2', 'r2/merge/1', at)).toBeNull();
  });
});
