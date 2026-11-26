/**
 * The states a flow writes while it drives a run (`FLOW_TRANSITIONS` in
 * `factory-runs.ts`): `updateInFlight` writes a new state only from the stored
 * states the table allows, a compare-and-set. Real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import type { FactoryRunState } from '@funny/shared/contracts/factory';

import {
  createFactoryRunsRepository,
  flowTransitionFrom,
} from '../../../services/factory/factory-runs.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  testDb.db
    .insert(testDb.schema.factorySettings)
    .values({
      id: 'f1',
      projectId: 'p1',
      userId: 'alice',
      enabled: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as typeof testDb.schema.factorySettings.$inferInsert)
    .run();
});

async function runIn(state: FactoryRunState) {
  const runs = createFactoryRunsRepository();
  const run = (await runs.start({ factoryId: 'f1', issueNumber: 1, state }))._unsafeUnwrap();
  const stateOf = async () => (await runs.get(run.id))._unsafeUnwrap()!.state;
  return { runs, run, stateOf };
}

describe('flowTransitionFrom', () => {
  test('no flow writes a queue state', () => {
    expect(flowTransitionFrom('requested')).toBeNull();
    expect(flowTransitionFrom('queued')).toBeNull();
  });

  test('triage is entered only before the work, and asks only from triage', () => {
    expect(flowTransitionFrom('triaging')).toEqual(['queued', 'triaging']);
    expect(flowTransitionFrom('needs_info')).toEqual(['triaging']);
  });

  test('no state is written over an ended run', () => {
    const ended: FactoryRunState[] = ['merged', 'no_change', 'done', 'failed', 'stopped'];
    for (const to of ['working', 'waiting_human', 'merged', 'failed', 'stopped'] as const) {
      for (const from of ended) expect(flowTransitionFrom(to)).not.toContain(from);
    }
  });
});

describe('updateInFlight', () => {
  test('writes a state the stored state leads to', async () => {
    const { runs, run, stateOf } = await runIn('queued');
    expect((await runs.updateInFlight(run.id, { state: 'working' }))._unsafeUnwrap()).toBe(true);
    expect((await runs.updateInFlight(run.id, { state: 'pr_open' }))._unsafeUnwrap()).toBe(true);
    expect(await stateOf()).toBe('pr_open');
  });

  test('a parked run is not put back to work by a flow still finishing', async () => {
    const { runs, run, stateOf } = await runIn('waiting_human');
    const written = await runs.updateInFlight(run.id, { state: 'fixing', threadIds: ['t-late'] });
    expect(written._unsafeUnwrapErr()).toMatchObject({
      kind: 'illegal-transition',
      from: 'waiting_human',
      to: 'fixing',
    });
    // Nothing was written, not even the fields that came with the state.
    const stored = (await runs.get(run.id))._unsafeUnwrap()!;
    expect(stored.state).toBe('waiting_human');
    expect(stored.threadIds).toEqual([]);
    expect(await stateOf()).toBe('waiting_human');
  });

  test('a run whose work started does not go back to triage', async () => {
    const { runs, run, stateOf } = await runIn('pr_open');
    const written = await runs.updateInFlight(run.id, { state: 'triaging' });
    expect(written._unsafeUnwrapErr().kind).toBe('illegal-transition');
    expect(await stateOf()).toBe('pr_open');
  });

  test('an ended run is reported as ended, not as an illegal move', async () => {
    const { runs, run, stateOf } = await runIn('stopped');
    expect((await runs.updateInFlight(run.id, { state: 'working' }))._unsafeUnwrap()).toBe(false);
    expect(await stateOf()).toBe('stopped');
  });

  test('a parked run still takes writes that leave its state alone', async () => {
    const { runs, run } = await runIn('waiting_human');
    expect((await runs.updateInFlight(run.id, { currentStep: 'ci' }))._unsafeUnwrap()).toBe(true);
    expect((await runs.get(run.id))._unsafeUnwrap()!.currentStep).toBe('ci');
  });

  test('a member stops a run wherever it is live, a parked one included', async () => {
    for (const from of ['requested', 'triaging', 'merging', 'needs_info'] as const) {
      testDb.sqlite.query('DELETE FROM factory_runs').run();
      const { runs, run, stateOf } = await runIn(from);
      expect((await runs.updateInFlight(run.id, { state: 'stopped' }))._unsafeUnwrap()).toBe(true);
      expect(await stateOf()).toBe('stopped');
    }
  });
});

describe('markDone', () => {
  // #532: a stopped run whose issue was closed as a duplicate had no way off the board.
  test('a run that ended with no change or was stopped becomes done', async () => {
    for (const state of ['no_change', 'stopped'] as const) {
      const { runs, run, stateOf } = await runIn(state);
      expect((await runs.markDone(run.id))._unsafeUnwrap()).toBe(true);
      expect(await stateOf()).toBe('done');
      await testDb.db.delete(testDb.schema.factoryRuns).run();
    }
  });

  test('a failed, parked or live run is not marked done', async () => {
    for (const state of ['failed', 'waiting_human', 'working', 'merged'] as const) {
      const { runs, run, stateOf } = await runIn(state);
      expect((await runs.markDone(run.id))._unsafeUnwrap()).toBe(false);
      expect(await stateOf()).toBe(state);
      await testDb.db.delete(testDb.schema.factoryRuns).run();
    }
  });
});

describe('putOnHold / release', () => {
  const hold = { reason: 'blocked by an upstream bug', userId: 'alice', at: 'now' };

  test('a run waiting for a person or ended without merging goes on hold', async () => {
    for (const state of [
      'needs_info',
      'waiting_human',
      'failed',
      'no_change',
      'stopped',
    ] as const) {
      const { runs, run, stateOf } = await runIn(state);
      const held = await runs.putOnHold(run.id, { ...hold, from: state });
      expect(held._unsafeUnwrap()).toBe(true);
      expect(await stateOf()).toBe('on_hold');
      expect((await runs.get(run.id))._unsafeUnwrap()!.hold).toEqual({ ...hold, from: state });
      await testDb.db.delete(testDb.schema.factoryRuns).run();
    }
  });

  test('a run in flight, in the queue or merged is not put on hold', async () => {
    for (const state of ['requested', 'working', 'merging', 'merged', 'done'] as const) {
      const { runs, run, stateOf } = await runIn(state);
      expect((await runs.putOnHold(run.id, { ...hold, from: state }))._unsafeUnwrap()).toBe(false);
      expect(await stateOf()).toBe(state);
      await testDb.db.delete(testDb.schema.factoryRuns).run();
    }
  });

  test('a run on hold holds its issue but no slot', async () => {
    const { runs, run } = await runIn('failed');
    await runs.putOnHold(run.id, { ...hold, from: 'failed' });
    expect((await runs.activeByIssue('f1', 1))._unsafeUnwrap()?.id).toBe(run.id);
    expect((await runs.inFlight('f1'))._unsafeUnwrap()).toEqual([]);
  });

  test('release sends a run on hold to the back of the queue, to be triaged again', async () => {
    const { runs, run, stateOf } = await runIn('failed');
    await runs.putOnHold(run.id, { ...hold, from: 'failed' });
    const held = (await runs.get(run.id))._unsafeUnwrap()!;
    expect((await runs.release(held, ['t-impl']))._unsafeUnwrap()).toBe(true);
    const released = (await runs.get(run.id))._unsafeUnwrap()!;
    expect(released.state).toBe('requested');
    expect(released.threadIds).toEqual(['t-impl']);
    expect(released.completedAt).toBeNull();
    expect(await stateOf()).toBe('requested');
  });

  test('only a run on hold is released', async () => {
    const { runs, run, stateOf } = await runIn('failed');
    expect((await runs.release(run, []))._unsafeUnwrap()).toBe(false);
    expect(await stateOf()).toBe('failed');
  });

  test('a member stops a run on hold', async () => {
    const { runs, run, stateOf } = await runIn('waiting_human');
    await runs.putOnHold(run.id, { ...hold, from: 'waiting_human' });
    expect((await runs.updateInFlight(run.id, { state: 'stopped' }))._unsafeUnwrap()).toBe(true);
    expect(await stateOf()).toBe('stopped');
  });

  test('no flow writes over a run on hold', async () => {
    const { runs, run, stateOf } = await runIn('waiting_human');
    await runs.putOnHold(run.id, { ...hold, from: 'waiting_human' });
    const written = await runs.updateInFlight(run.id, { state: 'waiting_human' });
    expect(written._unsafeUnwrapErr().kind).toBe('illegal-transition');
    expect(await stateOf()).toBe('on_hold');
  });
});
