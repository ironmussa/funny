/**
 * Migration 120_user_profiles_utility_model (openspec thread-recap, task 1.2):
 * a profile saved before the migration reads recaps on and no utility model
 * (the claude-sdk / haiku default).
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('120_user_profiles_utility_model migration', () => {
  test('backfills existing profiles with recaps on and no utility model', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');

    // Rewind to the pre-120 shape with a profile already saved.
    db.run(sql`ALTER TABLE user_profiles DROP COLUMN utility_model`);
    db.run(sql`ALTER TABLE user_profiles DROP COLUMN thread_recap_enabled`);
    db.run(
      sql`INSERT INTO user_profiles (id, user_id, setup_completed, created_at, updated_at) VALUES ('p1', 'u1', 1, '2026-01-01', '2026-01-01')`,
    );
    db.run(sql`DELETE FROM _migrations WHERE name = '120_user_profiles_utility_model'`);
    await autoMigrate();

    expect(
      db.all<{ utility_model: string | null; thread_recap_enabled: number }>(
        sql`SELECT utility_model, thread_recap_enabled FROM user_profiles WHERE id = 'p1'`,
      ),
    ).toEqual([{ utility_model: null, thread_recap_enabled: 1 }]);

    // A profile inserted later without the column gets the same default.
    db.run(
      sql`INSERT INTO user_profiles (id, user_id, created_at, updated_at) VALUES ('p2', 'u2', '2026-01-02', '2026-01-02')`,
    );
    expect(
      db.all<{ thread_recap_enabled: number }>(
        sql`SELECT thread_recap_enabled FROM user_profiles WHERE id = 'p2'`,
      ),
    ).toEqual([{ thread_recap_enabled: 1 }]);
  });
});
