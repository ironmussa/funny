/**
 * Migration 121_drop_threads_scheduler_managed: the column is gone from a
 * database that had it, threads keep their rows, and a second run is a no-op.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('121_drop_threads_scheduler_managed migration', () => {
  test('drops threads.scheduler_managed and keeps the thread rows', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const hasColumn = () =>
      db
        .all<{ name: string }>(sql.raw('PRAGMA table_info("threads")'))
        .some((column) => column.name === 'scheduler_managed');

    expect(hasColumn()).toBe(false);

    // Rewind to the pre-121 shape, with a thread that had the flag on.
    run(sql`ALTER TABLE threads ADD COLUMN scheduler_managed INTEGER NOT NULL DEFAULT 0`);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO threads (id, project_id, user_id, title, mode, status, scheduler_managed, created_at) VALUES ('t1', 'p', 'u', 'Kept', 'local', 'completed', 1, '2026-01-01')`,
    );
    run(sql`DELETE FROM _migrations WHERE name = '121_drop_threads_scheduler_managed'`);

    await autoMigrate();

    expect(hasColumn()).toBe(false);
    expect(db.all<{ title: string }>(sql`SELECT title FROM threads WHERE id = 't1'`)).toEqual([
      { title: 'Kept' },
    ]);

    // Idempotent: the helper checks before dropping.
    run(sql`DELETE FROM _migrations WHERE name = '121_drop_threads_scheduler_managed'`);
    await autoMigrate();
    expect(hasColumn()).toBe(false);
  });
});
