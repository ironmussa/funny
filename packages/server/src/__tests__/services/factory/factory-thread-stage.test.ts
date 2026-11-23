/**
 * A factory run's state decides its threads' kanban stage
 * (`factory-thread-stage.ts`): every run write that sets `state` moves the
 * threads with a compare-and-set from their stored stage. Real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import {
  stageForRunState,
  threadStageMove,
} from '../../../services/factory/factory-thread-stage.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';

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

function stageOf(threadId: string): string {
  const [row] = testDb.db
    .select({ stage: testDb.schema.threads.stage })
    .from(testDb.schema.threads)
    .where(eq(testDb.schema.threads.id, threadId))
    .all();
  return row!.stage;
}

async function runWithThread(stage: string, extra: Record<string, unknown> = {}) {
  seedThread(testDb.db, { id: 't1', projectId: 'p1', userId: 'alice', stage, ...extra });
  const runs = createFactoryRunsRepository();
  const run = (
    await runs.start({ factoryId: 'f1', issueNumber: 1, threadIds: ['t1'], state: 'working' })
  )._unsafeUnwrap();
  return { runs, run };
}

describe('stageForRunState', () => {
  test('maps every state of the run', () => {
    expect(stageForRunState('working')).toBe('in_progress');
    expect(stageForRunState('waiting_ci')).toBe('in_progress');
    expect(stageForRunState('waiting_human')).toBe('review');
    expect(stageForRunState('failed')).toBe('review');
    expect(stageForRunState('merged')).toBe('done');
    expect(stageForRunState('stopped')).toBeNull();
    expect(stageForRunState('queued')).toBeNull();
  });

  test('never moves a thread out of done', () => {
    expect(threadStageMove('working', 'done')).toBeNull();
    expect(threadStageMove('failed', 'done')).toBeNull();
    expect(threadStageMove('merged', 'review')).toEqual({ from: 'review', to: 'done' });
  });
});

describe('syncRunThreadStages through the run writes', () => {
  test('a merged run moves its reviewed thread to done and records the move', async () => {
    const { runs, run } = await runWithThread('review');
    await runs.updateInFlight(run.id, { state: 'merged' });
    expect(stageOf('t1')).toBe('done');
    const history = testDb.db.select().from(testDb.schema.stageHistory).all();
    expect(history.map((h) => [h.fromStage, h.toStage])).toEqual([['review', 'done']]);
  });

  test('a run back at work moves the thread the runtime set to review back in progress', async () => {
    const { runs, run } = await runWithThread('review');
    await runs.advance(run.id, 'working', { state: 'pr_open' });
    expect(stageOf('t1')).toBe('in_progress');
  });

  test('a parked or failed run puts its thread in review', async () => {
    const { runs, run } = await runWithThread('in_progress');
    await runs.updateInFlight(run.id, { state: 'waiting_human' });
    expect(stageOf('t1')).toBe('review');
  });

  test('a parked run closed by its merged pull request moves to done', async () => {
    const { runs, run } = await runWithThread('in_progress');
    await runs.updateInFlight(run.id, { state: 'waiting_human' });
    await runs.closeParked(run.id, 'merged');
    expect(stageOf('t1')).toBe('done');
  });

  test('a stopped run leaves its thread where it is', async () => {
    const { runs, run } = await runWithThread('in_progress');
    await runs.updateInFlight(run.id, { state: 'stopped' });
    expect(stageOf('t1')).toBe('in_progress');
  });

  test('an archived thread keeps its stage', async () => {
    const { runs, run } = await runWithThread('review', { archived: 1 });
    await runs.updateInFlight(run.id, { state: 'merged' });
    expect(stageOf('t1')).toBe('review');
  });

  test('a write refused by its compare-and-set moves nothing', async () => {
    const { runs, run } = await runWithThread('review');
    await runs.advance(run.id, 'pr_open', { state: 'merged' });
    expect(stageOf('t1')).toBe('review');
  });
});
