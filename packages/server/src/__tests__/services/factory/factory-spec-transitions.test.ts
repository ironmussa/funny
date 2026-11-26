/**
 * The spec stage's writes on the runs repository (openspec
 * factory-spec-stage): `needs_spec` is written only from triage, a spec
 * result is stored only while the run waits on it, approval is one
 * compare-and-set pinned to the draft's revision, and reopening is refused
 * while the run is in flight. Real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  FACTORY_RUN_HOLDABLE_STATES,
  type FactoryRunState,
  type FactorySpec,
  type FactoryRunSpec,
} from '@funny/shared/contracts/factory';

import { QUEUE_TRANSITIONS } from '../../../services/factory/factory-runs-model.js';
import {
  createFactoryRunsRepository,
  flowTransitionFrom,
  threadsOf,
} from '../../../services/factory/factory-runs.js';
import { issueChangedSince } from '../../../services/factory/factory-triage.js';
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

const DRAFT: FactorySpec = {
  summary: 'Add a logout button',
  decisions: [{ question: 'Where does it live?', answer: 'In the user menu' }],
  behavior: ['The user menu shows Log out'],
  approach: [],
  outOfScope: [],
  validation: ['Log out ends the session'],
  contract: {
    acceptanceCriteria: ['A user can log out'],
    likelyPaths: ['src/menu/**'],
    riskHints: [],
  },
};

async function runIn(state: FactoryRunState) {
  const runs = createFactoryRunsRepository();
  const run = (await runs.start({ factoryId: 'f1', issueNumber: 1, state }))._unsafeUnwrap();
  const read = async () => (await runs.get(run.id))._unsafeUnwrap()!;
  return { runs, run, read };
}

/** A run parked on its spec, with the spec writer's thread and a stored draft. */
async function waitingOnDraft() {
  const parked = await runIn('triaging');
  await parked.runs.updateInFlight(parked.run.id, {
    state: 'needs_spec',
    triage: {
      decision: 'needs_spec',
      at: new Date().toISOString(),
      decisions: [{ question: 'Where does it live?', options: [] }],
      findings: [],
    },
  });
  const stored = await parked.runs.updateSpec(parked.run.id, (current) => ({
    ...current,
    threadId: 'spec-thread',
    latest: { status: 'draft', spec: DRAFT },
    revision: (current?.revision ?? 0) + 1,
  }));
  expect(stored._unsafeUnwrap()?.revision).toBe(1);
  return parked;
}

describe('needs_spec transitions', () => {
  test('only triage parks a run on its spec', () => {
    expect(flowTransitionFrom('needs_spec')).toEqual(['triaging']);
  });

  test('a run on its spec can be held, approved, retriaged and stopped', () => {
    expect(FACTORY_RUN_HOLDABLE_STATES).toContain('needs_spec');
    expect(QUEUE_TRANSITIONS.approveSpec).toEqual({ from: ['needs_spec'], to: 'requested' });
    expect(QUEUE_TRANSITIONS.retriage.from).toContain('needs_spec');
    expect(flowTransitionFrom('stopped')).toContain('needs_spec');
  });

  test('a flow cannot write needs_spec over a run at work', async () => {
    const { runs, run, read } = await runIn('working');
    const written = await runs.updateInFlight(run.id, { state: 'needs_spec' });
    expect(written._unsafeUnwrapErr()).toMatchObject({ kind: 'illegal-transition' });
    expect((await read()).state).toBe('working');
  });

  test('the spec thread is among the threads a stop reaches', async () => {
    const { read } = await waitingOnDraft();
    expect(threadsOf(await read())).toContain('spec-thread');
  });

  test('a result is stored only while the run waits on its spec', async () => {
    const { runs, run } = await runIn('working');
    const stored = await runs.updateSpec(run.id, () => ({ revision: 1 }));
    expect(stored._unsafeUnwrap()).toBeNull();
  });
});

describe('approveSpec', () => {
  test('approving the draft shown sends the run back to the queue with its contract', async () => {
    const { runs, run, read } = await waitingOnDraft();
    const order = (await read()).queueOrder;
    const outcome = (await runs.approveSpec(run.id, 1, 'alice'))._unsafeUnwrap();
    expect(outcome.approved).toBe(true);
    const after = await read();
    expect(after.state).toBe('requested');
    expect(after.queueOrder).toBe(order);
    expect(after.triage).toMatchObject({
      decision: 'ready',
      fromSpec: true,
      contract: DRAFT.contract,
    });
    expect(after.spec?.approved).toMatchObject({ revision: 1, by: 'alice', spec: DRAFT });
  });

  test('a newer draft stored meanwhile refuses the approval', async () => {
    const { runs, run, read } = await waitingOnDraft();
    await runs.updateSpec(run.id, (current) => ({
      ...(current as FactoryRunSpec),
      revision: (current?.revision ?? 0) + 1,
    }));
    const outcome = (await runs.approveSpec(run.id, 1, 'alice'))._unsafeUnwrap();
    expect(outcome).toEqual({ approved: false, reason: 'revision-moved' });
    expect((await read()).state).toBe('needs_spec');
  });

  test('questions are not a draft to approve', async () => {
    const { runs, run } = await waitingOnDraft();
    await runs.updateSpec(run.id, (current) => ({
      ...(current as FactoryRunSpec),
      latest: { status: 'questions', questions: [{ question: 'Which menu?', options: [] }] },
      revision: 2,
    }));
    const outcome = (await runs.approveSpec(run.id, 2, 'alice'))._unsafeUnwrap();
    expect(outcome).toEqual({ approved: false, reason: 'no-draft' });
  });

  test('a run that is not waiting on its spec is refused', async () => {
    const { runs, run } = await runIn('waiting_human');
    const outcome = (await runs.approveSpec(run.id, 0, 'alice'))._unsafeUnwrap();
    expect(outcome).toEqual({ approved: false, reason: 'not-waiting-for-spec' });
  });

  test('an issue edit does not discard an approved spec', async () => {
    const { runs, run, read } = await waitingOnDraft();
    await runs.approveSpec(run.id, 1, 'alice');
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(issueChangedSince((await read()).triage, later)).toBe(false);
  });

  test('a release from hold keeps the approved spec as the contract', async () => {
    const { runs, run, read } = await waitingOnDraft();
    await runs.approveSpec(run.id, 1, 'alice');
    // Admitted, parked after the work, held, released.
    testDb.sqlite.run(`UPDATE factory_runs SET state = 'waiting_human' WHERE id = '${run.id}'`);
    await runs.putOnHold(run.id, {
      reason: 'upstream bug',
      userId: 'alice',
      at: new Date().toISOString(),
      from: 'waiting_human',
    });
    await runs.release(await read(), []);
    expect((await read()).triage).toMatchObject({ fromSpec: true });
    expect((await read()).triage?.superseded).toBeUndefined();
  });
});

describe('reopenSpec', () => {
  test('a parked run with an approved spec goes back to needs_spec without its approval', async () => {
    const { runs, run, read } = await waitingOnDraft();
    await runs.approveSpec(run.id, 1, 'alice');
    testDb.sqlite.run(`UPDATE factory_runs SET state = 'waiting_human' WHERE id = '${run.id}'`);
    const reopened = (await runs.reopenSpec(run.id))._unsafeUnwrap();
    expect(reopened?.approved).toBeUndefined();
    const after = await read();
    expect(after.state).toBe('needs_spec');
    expect(after.spec?.threadId).toBe('spec-thread');
    expect(after.triage?.superseded).toBe(true);
  });

  test('an approved spec waiting in the queue can be reopened', async () => {
    const { runs, run, read } = await waitingOnDraft();
    await runs.approveSpec(run.id, 1, 'alice');
    expect((await runs.reopenSpec(run.id))._unsafeUnwrap()).not.toBeNull();
    expect((await read()).state).toBe('needs_spec');
  });

  test('a run in flight is refused: it is stopped first', async () => {
    const { runs, run, read } = await runIn('working');
    expect((await runs.reopenSpec(run.id))._unsafeUnwrap()).toBeNull();
    expect((await read()).state).toBe('working');
  });
});
