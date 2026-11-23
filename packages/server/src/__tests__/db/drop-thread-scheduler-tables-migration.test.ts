/**
 * Migration 120_drop_thread_scheduler_tables: the thread scheduler's tables are
 * gone from a database that had them (with rows), and a fresh database has none.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('120_drop_thread_scheduler_tables migration', () => {
  test('drops scheduler_runs and thread_dependencies, with their rows', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const tables = () =>
      db
        .all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('scheduler_runs', 'thread_dependencies')`,
        )
        .map((row) => row.name);

    expect(tables()).toEqual([]);

    // Rewind to the pre-120 shape, with a row in each table.
    run(sql`
      CREATE TABLE scheduler_runs (
        thread_id TEXT PRIMARY KEY,
        last_event_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    run(sql`
      CREATE TABLE thread_dependencies (
        thread_id TEXT NOT NULL,
        blocked_by TEXT NOT NULL,
        PRIMARY KEY (thread_id, blocked_by)
      )
    `);
    run(sql`INSERT INTO scheduler_runs VALUES ('t1', 1, 1, 'u1', 1)`);
    run(sql`INSERT INTO thread_dependencies VALUES ('t1', 't2')`);
    run(sql`DELETE FROM _migrations WHERE name = '120_drop_thread_scheduler_tables'`);

    await autoMigrate();

    expect(tables()).toEqual([]);
  });
});
