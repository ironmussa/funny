/**
 * A run's role threads (triage, review) are stored as each one starts, so a
 * triage or a review still working can be linked to its thread and is
 * stopped with the run. Real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createFactoryRunsRepository, threadsOf } from '../../../services/factory/factory-runs.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

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

describe('role threads of a factory run', () => {
  test('a new run has none', async () => {
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId: 'f1', issueNumber: 1, threadIds: [], state: 'working' })
    )._unsafeUnwrap();
    expect(run.roleThreads).toEqual([]);
  });

  test('stored and read back; a triage still working is among the threads the run stops', async () => {
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({ factoryId: 'f1', issueNumber: 1, threadIds: [], state: 'triaging' })
    )._unsafeUnwrap();
    const roleThreads = [
      { role: 'triage' as const, threadId: 'tri-1', startedAt: '2026-11-25T10:00:00.000Z' },
    ];
    (await runs.update(run.id, { roleThreads }))._unsafeUnwrap();

    const read = (await runs.get(run.id))._unsafeUnwrap();
    expect(read?.roleThreads).toEqual(roleThreads);
    // No triage answer yet: before, nothing named this thread.
    expect(read?.triage).toBeNull();
    expect(threadsOf(read!)).toEqual(['tri-1']);
  });
});
