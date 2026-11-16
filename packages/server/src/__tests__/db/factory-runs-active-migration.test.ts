/**
 * Migration 098_factory_runs_one_active_per_issue: older duplicate in-flight
 * runs of an issue are stopped, the newest is kept, and the database then
 * refuses a second in-flight run for the issue while allowing a new run once
 * the first one ended.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('098_factory_runs_one_active_per_issue migration', () => {
  test('stops older duplicates and enforces one in-flight run per issue', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => (db as any).run(q);

    // Rewind to the pre-098 shape.
    run(sql`DROP INDEX factory_runs_one_active_per_issue`);
    run(sql`ALTER TABLE factory_runs DROP COLUMN launch_started_at`);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, created_at, updated_at) VALUES ('f', 'p', 'u', '2026-01-01', '2026-01-01')`,
    );
    const insertRun = (id: string, issue: number, state: string, startedAt: string) =>
      run(
        sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, started_at) VALUES (${id}, 'f', ${issue}, ${state}, ${startedAt})`,
      );
    insertRun('old', 7, 'working', '2026-01-01T00:00:00Z');
    insertRun('new', 7, 'waiting_ci', '2026-01-02T00:00:00Z');
    insertRun('done', 7, 'failed', '2025-12-31T00:00:00Z');
    insertRun('other', 8, 'working', '2026-01-01T00:00:00Z');

    run(sql`DELETE FROM _migrations WHERE name = '098_factory_runs_one_active_per_issue'`);
    await autoMigrate();

    const states = Object.fromEntries(
      (
        (db as any).all(sql`SELECT id, state FROM factory_runs`) as { id: string; state: string }[]
      ).map((r) => [r.id, r.state]),
    );
    expect(states).toEqual({ old: 'stopped', new: 'waiting_ci', done: 'failed', other: 'working' });

    expect(() => insertRun('dup', 7, 'queued', '2026-01-03T00:00:00Z')).toThrow();
    run(sql`UPDATE factory_runs SET state = 'merged' WHERE id = 'new'`);
    expect(() => insertRun('next', 7, 'queued', '2026-01-03T00:00:00Z')).not.toThrow();
  });
});
