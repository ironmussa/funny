/**
 * Migration 103_workflow_journal_and_leases: the engine's journal and the
 * concurrency-group lease and waiter tables, keyed so one execution (run,
 * node, visit, attempt) and one holder per group have one row each. An
 * execution hangs off its factory run and is deleted with it.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('103_workflow_journal_and_leases migration', () => {
  test('creates the tables with their keys, and re-running it is harmless', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, created_at, updated_at) VALUES ('f', 'p', 'u', '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, started_at) VALUES ('r', 'f', 7, '2026-01-01')`,
    );

    run(sql`
      INSERT INTO workflow_node_executions (run_id, node_id, visit, attempt, status, started_at)
      VALUES ('r', 'merge', '2.1', 1, 'running', 1763600000000)
    `);
    expect(() =>
      run(sql`
        INSERT INTO workflow_node_executions (run_id, node_id, visit, attempt, status, started_at)
        VALUES ('r', 'merge', '2.1', 1, 'succeeded', 1)
      `),
    ).toThrow();
    run(sql`
      INSERT INTO workflow_node_executions (run_id, node_id, visit, attempt, status, started_at)
      VALUES ('r', 'merge', '2.1', 2, 'running', 2)
    `);

    run(sql`
      INSERT INTO workflow_concurrency_leases (group_key, holder, expires_at, acquired_at)
      VALUES ('merge-o/r', 'r/merge/1', 1763600120000, 1763600000000)
    `);
    expect(() =>
      run(sql`
        INSERT INTO workflow_concurrency_leases (group_key, holder, expires_at, acquired_at)
        VALUES ('merge-o/r', 'r/merge/1', 1, 1)
      `),
    ).toThrow();

    run(sql`
      INSERT INTO workflow_concurrency_waiters (group_key, holder, slot_limit, requested_at, expires_at)
      VALUES ('merge-o/r', 's/merge/1', 1, 1, 2)
    `);
    expect(
      all<{ priority: number; leader: string | null }>(
        sql`SELECT priority, leader FROM workflow_concurrency_waiters`,
      ),
    ).toEqual([{ priority: 0, leader: null }]);

    run(sql`DELETE FROM _migrations WHERE name = '103_workflow_journal_and_leases'`);
    await autoMigrate();
    expect(all<{ n: number }>(sql`SELECT count(*) AS n FROM workflow_node_executions`)).toEqual([
      { n: 2 },
    ]);

    // An execution belongs to a factory run, and goes with it.
    expect(() =>
      run(sql`
        INSERT INTO workflow_node_executions (run_id, node_id, visit, attempt, status, started_at)
        VALUES ('ghost', 'merge', '1', 1, 'running', 1)
      `),
    ).toThrow();
    run(sql`DELETE FROM factory_settings WHERE id = 'f'`);
    expect(all<{ n: number }>(sql`SELECT count(*) AS n FROM workflow_node_executions`)).toEqual([
      { n: 0 },
    ]);
  });
});
