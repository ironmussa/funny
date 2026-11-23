/**
 * Batches of the factory's merge queue (openspec factory-integration 4.1):
 * one active batch per base branch, transitions only from their legal states,
 * rebuilds that count their attempts, and bisection attempts under a batch.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  BATCH_TRANSITIONS,
  createFactoryBatchesRepository,
  type FactoryBatchMember,
} from '../../../services/factory/factory-batches.js';
import { createTestDb } from '../../helpers/test-db.js';

const batches = createFactoryBatchesRepository();

const member = (runId: string, prNumber: number): FactoryBatchMember => ({
  runId,
  factoryId: 'f1',
  userId: 'alice',
  projectId: 'p1',
  prNumber,
  headSha: `head-${runId}`,
});

let repo: string;

/** Start a batch on `repo`'s `main` and return its id. */
async function started(members: FactoryBatchMember[], baseBranch = 'main'): Promise<string> {
  const batch = await batches.start({ repo, baseBranch, leaderRunId: members[0]!.runId, members });
  return batch._unsafeUnwrap()!.id;
}

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
  repo = 'o/r';
});

describe('factory batches', () => {
  test('one active batch per repository and base branch; another branch has its own', async () => {
    const id = await started([member('r1', 1)]);
    expect((await batches.get(id))._unsafeUnwrap()).toMatchObject({
      state: 'building',
      attempt: 1,
      stagingBranch: `factory/staging/${id}`,
      queueBranch: `factory/queue/${id}`,
    });
    const second = await batches.start({
      repo,
      baseBranch: 'main',
      leaderRunId: 'r2',
      members: [member('r2', 2)],
    });
    expect(second._unsafeUnwrap()).toBeNull();
    await started([member('r3', 3)], 'release');
    expect((await batches.active(repo, 'main'))._unsafeUnwrap()?.id).toBe(id);
  });

  test('a batch that ended frees its base branch for the next one', async () => {
    const id = await started([member('r1', 1)]);
    expect((await batches.move(id, 'test', { baseSha: 'B', queueSha: 'Q' }))._unsafeUnwrap()).toBe(
      true,
    );
    expect((await batches.move(id, 'merge'))._unsafeUnwrap()).toBe(true);
    const result = {
      summary: 'merged #1',
      landed: [{ runId: 'r1', sha: 'L1' }],
      culprits: [],
      requeued: [],
      flake: false,
    };
    expect((await batches.move(id, 'merged', { result }))._unsafeUnwrap()).toBe(true);
    const ended = (await batches.get(id))._unsafeUnwrap()!;
    expect(ended).toMatchObject({
      state: 'merged',
      baseSha: 'B',
      queueSha: 'Q',
      endedAt: expect.any(String),
    });
    expect(ended.result?.landed).toEqual([{ runId: 'r1', sha: 'L1' }]);
    expect((await batches.active(repo, 'main'))._unsafeUnwrap()).toBeNull();
    await started([member('r2', 2)]);
  });

  test('a transition from a state it does not start from writes nothing', async () => {
    const id = await started([member('r1', 1)]);
    // Building: CI has not tested it, so it can neither merge nor bisect.
    expect((await batches.move(id, 'merge'))._unsafeUnwrap()).toBe(false);
    expect((await batches.move(id, 'bisect'))._unsafeUnwrap()).toBe(false);
    expect((await batches.get(id))._unsafeUnwrap()?.state).toBe('building');
    // An ended batch stays ended.
    await batches.move(id, 'abandon');
    expect((await batches.move(id, 'test'))._unsafeUnwrap()).toBe(false);
    expect((await batches.rebuild(id, [member('r1', 1)]))._unsafeUnwrap()).toBe(false);
  });

  test('a rebuild goes back to building with the next attempt and the members left', async () => {
    const id = await started([member('r1', 1), member('r2', 2)]);
    await batches.move(id, 'test', { baseSha: 'B', queueSha: 'Q' });
    expect((await batches.rebuild(id, [member('r1', 1)]))._unsafeUnwrap()).toBe(true);
    expect((await batches.get(id))._unsafeUnwrap()).toMatchObject({
      state: 'building',
      attempt: 2,
      queueSha: null,
      members: [member('r1', 1)],
    });
  });

  test('bisection attempts are kept under their batch and end once', async () => {
    const id = await started([member('r1', 1), member('r2', 2)]);
    await batches.move(id, 'test');
    await batches.move(id, 'retest');
    expect((await batches.move(id, 'bisect'))._unsafeUnwrap()).toBe(true);
    const left = (await batches.addAttempt(id, ['r1'], `factory/queue/${id}-a`))._unsafeUnwrap();
    const right = (await batches.addAttempt(id, ['r2'], `factory/queue/${id}-b`))._unsafeUnwrap();
    expect((await batches.attemptSha(left.id, 'S1'))._unsafeUnwrap()).toBe(true);
    expect((await batches.endAttempt(left.id, 'green'))._unsafeUnwrap()).toBe(true);
    expect((await batches.endAttempt(left.id, 'red'))._unsafeUnwrap()).toBe(false);
    expect((await batches.endAttempt(right.id, 'red', { checks: ['test'] }))._unsafeUnwrap()).toBe(
      true,
    );
    const attempts = (await batches.attemptsOf(id))._unsafeUnwrap();
    expect(attempts.map((a) => [a.members, a.state, a.sha])).toEqual([
      [['r1'], 'green', 'S1'],
      [['r2'], 'red', null],
    ]);
    expect((await batches.move(id, 'split'))._unsafeUnwrap()).toBe(true);
  });

  test('every transition starts only from active states', () => {
    for (const { from } of Object.values(BATCH_TRANSITIONS)) {
      for (const state of from) {
        expect(['building', 'testing', 'retesting', 'bisecting', 'merging']).toContain(state);
      }
    }
  });
});
