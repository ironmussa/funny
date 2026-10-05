/**
 * Migration 081_drop_retired_columns: columns no code reads (including an old
 * plaintext-era `user_profiles.github_token`) are dropped from existing
 * databases, without touching the rows that held them.
 */
import { describe, test, expect } from 'bun:test';

import { sql } from 'drizzle-orm';

const RETIRED = [
  ['agent_templates', 'memory_override'],
  ['agent_templates', 'custom_memory_paths'],
  ['projects', 'memory_enabled'],
  ['threads', 'automation_id'],
  ['user_profiles', 'github_token'],
  ['user_profiles', 'assemblyai_api_key'],
] as const;

describe('081_drop_retired_columns migration', () => {
  test('drops the retired columns from a database that still has them', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const columns = (table: string) =>
      ((db as any).all(sql.raw(`PRAGMA table_info(${table})`)) as { name: string }[]).map(
        (c) => c.name,
      );

    // A fresh database never keeps them.
    for (const [table, column] of RETIRED) expect(columns(table)).not.toContain(column);

    // Simulate a database from before 081 holding a secret in a retired column.
    (db as any).run(sql`ALTER TABLE user_profiles ADD COLUMN github_token TEXT`);
    const now = new Date().toISOString();
    (db as any).run(sql`
      INSERT INTO user_profiles (id, user_id, github_token, created_at, updated_at)
      VALUES ('up1', 'u1', 'ghp_secret', ${now}, ${now})
    `);
    (db as any).run(sql`DELETE FROM _migrations WHERE name = '081_drop_retired_columns'`);

    await autoMigrate();

    expect(columns('user_profiles')).not.toContain('github_token');
    const rows = (db as any).all(sql`SELECT id FROM user_profiles WHERE id = 'up1'`) as unknown[];
    expect(rows).toHaveLength(1);

    // Idempotent on re-run.
    (db as any).run(sql`DELETE FROM _migrations WHERE name = '081_drop_retired_columns'`);
    await autoMigrate();
  });
});
