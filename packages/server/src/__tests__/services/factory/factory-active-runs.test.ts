/**
 * The runs the thread lists show on their threads (`activeForOwner`): a run
 * that ended without a merge (failed, stopped, no change) stays listed for a
 * while, so its thread does not read as done; a merged one does not; real
 * test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { factoryRuns } from '../../../db/schema.js';
import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

const NOW = Date.parse('2026-11-23T23:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let testDb: ReturnType<typeof createTestDb>;

async function factoryFor(userId: string, projectId: string): Promise<string> {
  const settings = createFactorySettingsService();
  (await settings.save(userId, projectId, { enabled: true }))._unsafeUnwrap();
  const found = await settings.factoryId(userId, projectId);
  if (found.isErr() || !found.value) throw new Error('no factory id');
  return found.value;
}

describe('activeForOwner', () => {
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
  });

  test('lists in-flight runs and runs ended without a merge lately, not merged or old ones', async () => {
    const factoryId = await factoryFor('alice', 'p1');
    const runs = createFactoryRunsRepository();
    const ended = async (
      issueNumber: number,
      state: 'failed' | 'stopped' | 'no_change' | 'merged',
      endedAgo: number,
    ) => {
      const run = (
        await runs.start({
          factoryId,
          issueNumber,
          threadIds: [`t-${issueNumber}`],
          state: 'working',
        })
      )._unsafeUnwrap();
      testDb.db
        .update(factoryRuns)
        .set({ state, completedAt: new Date(NOW - endedAgo).toISOString() })
        .where(eq(factoryRuns.id, run.id))
        .run();
      return run;
    };
    await runs.start({ factoryId, issueNumber: 1, threadIds: ['t-1'], state: 'waiting_ci' });
    await ended(2, 'failed', DAY);
    await ended(3, 'stopped', DAY);
    await ended(4, 'no_change', DAY);
    await ended(5, 'merged', DAY);
    await ended(6, 'stopped', 30 * DAY);
    await runs.start({ factoryId, issueNumber: 7, threadIds: [], state: 'requested' });

    const listed = (await runs.activeForOwner('alice', NOW))._unsafeUnwrap();
    expect(listed.map((r) => r.issueNumber).sort()).toEqual([1, 2, 3, 4]);
    expect((await runs.activeForOwner('bob', NOW))._unsafeUnwrap()).toEqual([]);
  });
});
