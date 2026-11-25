/**
 * Migration 134_factory_runs_issue_index_done_terminal: the one-run-per-issue
 * index leaves out every terminal run state, `done` included. Before it, a
 * `done` run held its issue forever: the enqueue of a new run for the issue
 * was skipped without a word (#449).
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { TERMINAL_STATES } from '../../services/factory/factory-runs-model.js';

describe('134_factory_runs_issue_index_done_terminal migration', () => {
  test('a run in any terminal state no longer holds its issue; one in flight still does', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);

    // Rewind to the index as 119 left it, with a `done` run already stored.
    run(sql`DROP INDEX factory_runs_one_active_per_issue`);
    run(sql`
      CREATE UNIQUE INDEX factory_runs_one_active_per_issue
      ON factory_runs (factory_id, issue_number)
      WHERE issue_number > 0 AND state NOT IN ('merged', 'no_change', 'failed', 'stopped')
    `);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    const insertRun = (id: string, issue: number, state: string) =>
      run(
        sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, source, started_at) VALUES (${id}, 'f', ${issue}, ${state}, 'label', '2026-01-02')`,
      );
    insertRun('old-done', 449, 'done');
    expect(() => insertRun('blocked', 449, 'queued')).toThrow();

    run(sql`DELETE FROM _migrations WHERE name = '134_factory_runs_issue_index_done_terminal'`);
    await autoMigrate();

    // Every terminal state leaves the issue free, so the index matches the code.
    TERMINAL_STATES.forEach((state, i) => insertRun(`ended-${state}`, 500 + i, state));
    TERMINAL_STATES.forEach((_state, i) =>
      expect(() => insertRun(`again-${i}`, 500 + i, 'queued')).not.toThrow(),
    );
    expect(() => insertRun('requeued', 449, 'queued')).not.toThrow();
    // A run still in flight (or parked for a person) holds its issue.
    expect(() => insertRun('twice', 449, 'waiting_human')).toThrow();
  });
});
