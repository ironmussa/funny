/**
 * The workflow journal on the server database: record, replace, load per
 * run, delete with the run, and resume an engine run from it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { definePipeline, node, runPipeline } from '@funny/pipelines';
import { sql } from 'drizzle-orm';

import {
  createWorkflowJournalRepository,
  databaseJournal,
  type LoadedExecution,
} from '../../../services/workflow-engine/journal-repository.js';
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
  testDb.db.run(
    sql`INSERT INTO factory_settings (id, project_id, user_id, created_at, updated_at) VALUES ('f', 'p1', 'alice', '2026-01-01', '2026-01-01')`,
  );
  for (const [id, issue] of [
    ['run-1', 1],
    ['run-2', 2],
  ] as const) {
    testDb.db.run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, started_at) VALUES (${id}, 'f', ${issue}, '2026-01-01')`,
    );
  }
});

const execution = (patch: Partial<LoadedExecution> = {}): LoadedExecution => ({
  runId: 'run-1',
  nodeId: 'implement',
  visit: '1',
  attempt: 1,
  status: 'running',
  startedAt: 1_763_600_000_000,
  ...patch,
});

describe('workflow journal repository', () => {
  test('records an execution and replaces it as it moves on', async () => {
    const repo = createWorkflowJournalRepository();
    await repo.record(execution({ data: { threadId: 't-1' } }));
    await repo.record(
      execution({
        status: 'succeeded',
        data: { threadId: 't-1' },
        output: { implement: { output: 'done' } },
        finishedAt: 1_763_600_060_000,
      }),
    );
    const loaded = await repo.load('run-1');
    expect(loaded._unsafeUnwrap()).toEqual([
      execution({
        status: 'succeeded',
        data: { threadId: 't-1' },
        output: { implement: { output: 'done' } },
        finishedAt: 1_763_600_060_000,
      }),
    ]);
  });

  test('keeps each attempt and visit, and loads one run only', async () => {
    const repo = createWorkflowJournalRepository();
    await repo.record(execution({ status: 'cancelled' }));
    await repo.record(execution({ attempt: 2 }));
    await repo.record(execution({ visit: '2', attempt: 1 }));
    await repo.record(execution({ runId: 'run-2' }));
    const loaded = (await repo.load('run-1'))._unsafeUnwrap();
    expect(loaded.map((e) => [e.visit, e.attempt, e.status]).sort()).toEqual([
      ['1', 1, 'cancelled'],
      ['1', 2, 'running'],
      ['2', 1, 'running'],
    ]);
  });

  test('a run deleted (or retried from scratch) takes its executions with it', async () => {
    const repo = createWorkflowJournalRepository();
    await repo.record(execution());
    await repo.record(execution({ runId: 'run-2' }));
    await repo.deleteRun('run-1');
    expect((await repo.load('run-1'))._unsafeUnwrap()).toEqual([]);
    testDb.db.run(sql`DELETE FROM factory_runs WHERE id = 'run-2'`);
    expect((await repo.load('run-2'))._unsafeUnwrap()).toEqual([]);
  });

  test('an execution of an unknown run is refused', async () => {
    const result = await createWorkflowJournalRepository().record(execution({ runId: 'ghost' }));
    expect(result.isErr()).toBe(true);
  });
});

describe('database journal', () => {
  type Ctx = { live: string; outputs: Record<string, unknown> };
  // Store only the outputs; the live part comes back from the resuming host.
  const codec = (live: string) => ({
    encode: (ctx: Ctx) => ctx.outputs,
    decode: (stored: unknown) => ({ live, outputs: stored as Record<string, unknown> }),
  });

  test('a run resumes from the database without repeating recorded work', async () => {
    const repo = createWorkflowJournalRepository();
    const runs: string[] = [];
    const flow = (stopAfterFirst: boolean, controller?: AbortController) =>
      definePipeline<Ctx>({
        name: 'resume',
        nodes: [
          node('triage', (ctx: Ctx) => {
            runs.push(`triage:${ctx.live}`);
            return { ...ctx, outputs: { ...ctx.outputs, triage: 'bug' } };
          }),
          node<Ctx>('implement', async (ctx, signal, info) => {
            runs.push(`implement:${ctx.live}:${String(info.resume?.recorded.data ?? 'new')}`);
            if (stopAfterFirst) {
              await info.checkpoint('t-9');
              controller?.abort();
              signal.throwIfAborted();
            }
            return { ...ctx, outputs: { ...ctx.outputs, implement: 'done' } };
          }),
        ],
      });

    const controller = new AbortController();
    const first = await runPipeline(
      flow(true, controller),
      { live: 'server-a', outputs: {} },
      {
        journal: databaseJournal(repo, codec('server-a')),
        runId: 'run-1',
        signal: controller.signal,
      },
    );
    expect(first.outcome).toBe('cancelled');

    const resumed = await runPipeline(
      flow(false),
      { live: 'server-b', outputs: {} },
      { journal: databaseJournal(repo, codec('server-b')), runId: 'run-1' },
    );
    expect(resumed.outcome).toBe('completed');
    expect(resumed.ctx.outputs).toEqual({ triage: 'bug', implement: 'done' });
    expect(runs).toEqual(['triage:server-a', 'implement:server-a:new', 'implement:server-b:t-9']);
  });

  test('a journal that cannot record fails the node', async () => {
    const repo = createWorkflowJournalRepository();
    const result = await runPipeline(
      definePipeline<Ctx>({ name: 'ghost', nodes: [node('a', (ctx: Ctx) => ctx)] }),
      { live: 'x', outputs: {} },
      { journal: databaseJournal(repo, codec('x')), runId: 'ghost' },
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/Could not record the execution in the journal/);
  });
});
