/**
 * Migration 095_project_runtime_mode (project-runtime-settings): the per-user
 * sandbox row gains a `mode`, backfilled from the old `enabled_by_default` flag
 * (sandbox) or the project's default_mode, then the flag is dropped.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('095_project_runtime_mode migration', () => {
  test('backfills mode from enabled_by_default and the project default', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => (db as any).run(q);

    // Rewind to the pre-095 shape: drop `mode`, restore `enabled_by_default`.
    run(sql`ALTER TABLE project_sandbox_settings DROP COLUMN mode`);
    run(
      sql`ALTER TABLE project_sandbox_settings ADD COLUMN enabled_by_default INTEGER NOT NULL DEFAULT 0`,
    );

    const now = new Date().toISOString();
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at, default_mode) VALUES ('wt', 'wt', '/a', 'u1', ${now}, 'worktree')`,
    );
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('none', 'none', '/b', 'u1', ${now})`,
    );
    // enabled_by_default=1 → sandbox; =0 → the project's default_mode (or local).
    run(
      sql`INSERT INTO project_sandbox_settings (project_id, user_id, connection_id, size_id, enabled_by_default, updated_at) VALUES ('wt', 'u1', 'c1', 's', 1, ${now})`,
    );
    run(
      sql`INSERT INTO project_sandbox_settings (project_id, user_id, connection_id, size_id, enabled_by_default, updated_at) VALUES ('wt', 'u2', 'c1', 's', 0, ${now})`,
    );
    run(
      sql`INSERT INTO project_sandbox_settings (project_id, user_id, connection_id, size_id, enabled_by_default, updated_at) VALUES ('none', 'u1', 'c1', 's', 0, ${now})`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '095_project_runtime_mode'`);
    await autoMigrate();

    const mode = (projectId: string, userId: string) =>
      (
        (db as any).all(
          sql`SELECT mode FROM project_sandbox_settings WHERE project_id = ${projectId} AND user_id = ${userId}`,
        ) as { mode: string }[]
      )[0].mode;

    expect(mode('wt', 'u1')).toBe('sandbox');
    expect(mode('wt', 'u2')).toBe('worktree');
    expect(mode('none', 'u1')).toBe('local');
  });
});
