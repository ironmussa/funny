/**
 * Migration 122_user_profiles_utility_model (openspec `thread-recap`, task
 * 1.2): a profile saved before it has recaps on and the default utility model.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('122_user_profiles_utility_model migration', () => {
  test('an existing profile reads thread_recap_enabled = 1 and utility_model IS NULL', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');

    // Rewind to the pre-122 shape, with a profile saved then.
    db.run(sql`ALTER TABLE user_profiles DROP COLUMN utility_model`);
    db.run(sql`ALTER TABLE user_profiles DROP COLUMN thread_recap_enabled`);
    db.run(
      sql`INSERT INTO user_profiles (id, user_id, setup_completed, created_at, updated_at) VALUES ('p1', 'u1', 1, '2026-01-01', '2026-01-01')`,
    );
    db.run(sql`DELETE FROM _migrations WHERE name = '122_user_profiles_utility_model'`);

    await autoMigrate();

    expect(
      db.all<{ thread_recap_enabled: number; utility_model: string | null }>(
        sql`SELECT thread_recap_enabled, utility_model FROM user_profiles WHERE id = 'p1'`,
      ),
    ).toEqual([{ thread_recap_enabled: 1, utility_model: null }]);
  });
});
