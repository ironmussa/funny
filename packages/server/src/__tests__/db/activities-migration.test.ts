/** Migration 105_activities creates the activities table and its indexes. */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('105_activities migration', () => {
  test('creates the table on a fresh database', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');

    const columns = db.all<{ name: string }>(sql`PRAGMA table_info(activities)`).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'runner_id',
        'kind',
        'status',
        'input',
        'result_ref',
      ]),
    );
    const indexes = db.all<{ name: string }>(sql`PRAGMA index_list(activities)`).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_activities_user_started', 'idx_activities_runner_status']),
    );
  });
});
