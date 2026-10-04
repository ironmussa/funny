/**
 * Migration 079_project_runner_binding (project-runner-binding): runner roles,
 * the user's designated general runner, and per-project runner settings/grants.
 */
import { describe, test, expect } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('079_project_runner_binding migration', () => {
  test('adds runner role, general runner and project runner tables', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');

    const columns = (table: string) =>
      (db as any).all(sql.raw(`PRAGMA table_info(${table})`)).map((c: any) => c.name) as string[];

    expect(columns('runners')).toContain('role');
    expect(columns('user_profiles')).toContain('general_runner_id');
    expect(columns('project_runner_settings')).toEqual(
      expect.arrayContaining(['project_id', 'dedicated_runner_id', 'github_token', 'updated_at']),
    );
    expect(columns('project_runner_grants')).toEqual(
      expect.arrayContaining(['project_id', 'runner_id', 'created_at']),
    );

    // Existing / new runners default to the general role.
    const now = new Date().toISOString();
    (db as any).run(sql`
      INSERT INTO runners (id, name, hostname, token, registered_at, last_heartbeat_at)
      VALUES ('r1', 'r1', 'h1', 'tok', ${now}, ${now})
    `);
    const [row] = (db as any).all(sql`SELECT role FROM runners WHERE id = 'r1'`) as {
      role: string;
    }[];
    expect(row.role).toBe('general');

    // Migration is idempotent on re-run.
    await autoMigrate();
  });
});
