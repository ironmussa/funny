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

describe('106_activities_origin_effects migration', () => {
  test('rows written before it read as user-started with no effects', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);

    // Rewind to the pre-106 shape.
    run(sql`ALTER TABLE activities DROP COLUMN origin`);
    run(sql`ALTER TABLE activities DROP COLUMN effects`);
    run(
      sql`INSERT INTO activities (id, user_id, kind, title, started_at, updated_at) VALUES ('a', 'u', 'project.clone', 'Clone', '2026-01-01', '2026-01-01')`,
    );
    run(sql`DELETE FROM _migrations WHERE name = '106_activities_origin_effects'`);
    await autoMigrate();

    expect(
      db.all<{ origin: string; effects: string | null }>(
        sql`SELECT origin, effects FROM activities WHERE id = 'a'`,
      ),
    ).toEqual([{ origin: 'user', effects: null }]);
  });
});
