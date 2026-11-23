/**
 * Migration 119_factory_flow_triggers (change flow-triggers, task 1.1): runs
 * gain a trigger and inputs, a run without an issue (`issue_number = 0`) is
 * left out of the one-run-per-issue index, a schedule trigger has one working
 * run at a time (a parked one does not hold it), and triggers go with their
 * factory.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('119_factory_flow_triggers migration', () => {
  test('adds the trigger columns, restates the issue index and adds the trigger index', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind to the pre-119 shape.
    run(sql`DROP INDEX factory_runs_one_active_per_trigger`);
    run(sql`DROP INDEX factory_runs_one_active_per_issue`);
    run(sql`DROP TABLE factory_triggers`);
    for (const column of ['trigger_id', 'trigger_name', 'inputs']) {
      run(sql.raw(`ALTER TABLE factory_runs DROP COLUMN ${column}`));
    }
    run(sql`
      CREATE UNIQUE INDEX factory_runs_one_active_per_issue
      ON factory_runs (factory_id, issue_number)
      WHERE state NOT IN ('merged', 'no_change', 'failed', 'stopped')
    `);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, source, started_at) VALUES ('old', 'f', 7, 'working', 'manual', '2026-01-01')`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '119_factory_flow_triggers'`);
    await autoMigrate();

    expect(
      all<{ source: string; trigger_id: string | null; inputs: string | null }>(
        sql`SELECT source, trigger_id, inputs FROM factory_runs WHERE id = 'old'`,
      ),
    ).toEqual([{ source: 'manual', trigger_id: null, inputs: null }]);

    const insertRun = (id: string, issue: number, state: string, trigger: string | null) =>
      run(
        sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, trigger_id, started_at) VALUES (${id}, 'f', ${issue}, ${state}, ${trigger}, '2026-01-02')`,
      );

    // One run in flight per issue, as before.
    expect(() => insertRun('dup', 7, 'queued', null)).toThrow();
    // Runs without an issue do not collide with each other.
    expect(() => insertRun('now-1', 0, 'working', null)).not.toThrow();
    expect(() => insertRun('now-2', 0, 'working', null)).not.toThrow();

    // One working run per schedule trigger; a parked or ended one frees it.
    expect(() => insertRun('sched-1', 0, 'working', 't1')).not.toThrow();
    expect(() => insertRun('sched-2', 0, 'requested', 't1')).toThrow();
    expect(() => insertRun('other', 0, 'working', 't2')).not.toThrow();
    run(sql`UPDATE factory_runs SET state = 'waiting_human' WHERE id = 'sched-1'`);
    expect(() => insertRun('sched-3', 0, 'requested', 't1')).not.toThrow();
    run(sql`UPDATE factory_runs SET state = 'done' WHERE id = 'sched-3'`);
    expect(() => insertRun('sched-4', 0, 'queued', 't1')).not.toThrow();

    // Triggers are deleted with their factory.
    run(
      sql`INSERT INTO factory_triggers (id, factory_id, name, schedule, flow_name, created_at, updated_at) VALUES ('t1', 'f', 'Nightly', '0 3 * * *', 'audit', '2026-01-01', '2026-01-01')`,
    );
    run(sql`PRAGMA foreign_keys = ON`);
    run(sql`DELETE FROM factory_runs`);
    run(sql`DELETE FROM factory_settings WHERE id = 'f'`);
    expect(all(sql`SELECT id FROM factory_triggers`)).toEqual([]);
  });
});
