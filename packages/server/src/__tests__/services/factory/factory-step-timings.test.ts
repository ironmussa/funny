/**
 * A run's step timings (openspec factory-step-timings): the run lists carry
 * each flow node execution from the workflow journal, in start order, without
 * the executions' outputs; real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import {
  groupStepTimings,
  stepTimingsFor,
} from '../../../services/factory/factory-step-timings.js';
import {
  createWorkflowJournalRepository,
  type StoredExecution,
} from '../../../services/workflow-engine/journal-repository.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const min = (n: number) => T0 + n * 60_000;

async function factoryFor(userId: string, projectId: string): Promise<string> {
  const settings = createFactorySettingsService();
  (await settings.save(userId, projectId, { enabled: true }))._unsafeUnwrap();
  const found = await settings.factoryId(userId, projectId);
  if (found.isErr() || !found.value) throw new Error('no factory id');
  return found.value;
}

describe('step timings in the run lists', () => {
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
    seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  });

  test('a run with a loop and a retried step: every execution in start order, no outputs', async () => {
    const factoryId = await factoryFor('alice', 'p1');
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId, issueNumber: 7, threadIds: ['t-1'], state: 'reviewing' })
    )._unsafeUnwrap();
    const queued = (
      await runs.start({ factoryId, issueNumber: 8, threadIds: [], state: 'requested' })
    )._unsafeUnwrap();
    const journal = createWorkflowJournalRepository();
    const executions = [
      ['implement', '1', 1, 'succeeded', 0, 10],
      ['ci', '1', 1, 'failed', 11, 15],
      ['ci', '1', 2, 'succeeded', 16, 20],
      ['review', '1', 1, 'succeeded', 21, 30],
      ['address', '1', 1, 'succeeded', 31, 40],
      ['review', '2', 1, 'running', 41, null],
    ] as const;
    // Recorded out of order: the lists sort by start.
    for (const [nodeId, visit, attempt, status, start, end] of [...executions].reverse()) {
      const execution: StoredExecution = {
        runId: run.id,
        nodeId,
        visit,
        attempt,
        status,
        startedAt: min(start),
        output: { secret: 'large step output' },
      };
      if (end !== null) execution.finishedAt = min(end);
      (await journal.record(execution))._unsafeUnwrap();
    }

    const listed = (await runs.list(factoryId))._unsafeUnwrap();
    const timings = listed.find((r) => r.id === run.id)?.stepTimings ?? [];
    expect(timings.map((t) => [t.step, t.visit, t.attempt, t.status])).toEqual(
      executions.map(([step, visit, attempt, status]) => [step, visit, attempt, status]),
    );
    expect(timings[0]).toEqual({
      step: 'implement',
      visit: '1',
      attempt: 1,
      status: 'succeeded',
      startedAt: new Date(min(0)).toISOString(),
      finishedAt: new Date(min(10)).toISOString(),
    });
    expect(timings.at(-1)?.finishedAt).toBeNull();
    expect(JSON.stringify(timings)).not.toContain('large step output');
    expect(listed.find((r) => r.id === queued.id)?.stepTimings).toEqual([]);

    const queue = (await runs.queueForOwner('alice'))._unsafeUnwrap();
    expect(queue.find((r) => r.id === run.id)?.stepTimings).toHaveLength(6);
  });

  test("one run's executions never show on another's", async () => {
    const factoryId = await factoryFor('alice', 'p1');
    const runs = createFactoryRunsRepository();
    const a = (
      await runs.start({ factoryId, issueNumber: 1, threadIds: [], state: 'working' })
    )._unsafeUnwrap();
    const b = (
      await runs.start({ factoryId, issueNumber: 2, threadIds: [], state: 'working' })
    )._unsafeUnwrap();
    const journal = createWorkflowJournalRepository();
    (
      await journal.record({
        runId: a.id,
        nodeId: 'implement',
        visit: '1',
        attempt: 1,
        status: 'running',
        startedAt: min(0),
      })
    )._unsafeUnwrap();
    const listed = (await runs.list(factoryId))._unsafeUnwrap();
    expect(listed.find((r) => r.id === a.id)?.stepTimings).toHaveLength(1);
    expect(listed.find((r) => r.id === b.id)?.stepTimings).toEqual([]);
  });
});

describe('stepTimingsFor', () => {
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
    seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  });

  test('more run ids than one query takes still finds every run', async () => {
    const factoryId = await factoryFor('alice', 'p1');
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId, issueNumber: 3, threadIds: [], state: 'working' })
    )._unsafeUnwrap();
    (
      await createWorkflowJournalRepository().record({
        runId: run.id,
        nodeId: 'implement',
        visit: '1',
        attempt: 1,
        status: 'running',
        startedAt: min(0),
      })
    )._unsafeUnwrap();
    const ids = [...Array.from({ length: 1200 }, (_, i) => `missing-${i}`), run.id];
    const found = (await stepTimingsFor(ids, (e) => e))._unsafeUnwrap();
    expect([...found.keys()]).toEqual([run.id]);
  });
});

describe('groupStepTimings', () => {
  test('groups by run in start order and drops a status the contract does not know', () => {
    const row = (runId: string, nodeId: string, startedAt: number, status = 'succeeded') => ({
      runId,
      nodeId,
      visit: '1',
      attempt: 1,
      status,
      startedAt,
      finishedAt: startedAt + 1,
    });
    const grouped = groupStepTimings([
      row('r1', 'review', min(5)),
      row('r2', 'implement', min(1)),
      row('r1', 'implement', min(1)),
      row('r1', 'weird', min(9), 'paused'),
    ]);
    expect(grouped.get('r1')?.map((t) => t.step)).toEqual(['implement', 'review']);
    expect(grouped.get('r2')?.map((t) => t.step)).toEqual(['implement']);
  });
});
