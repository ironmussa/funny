/**
 * Migration 108_factory_runs_triage (change factory-agent-roles, phase 2):
 * existing runs have no triage, and the new states are stored like any other.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('108_factory_runs_triage migration', () => {
  test('adds the triage column, empty on existing runs', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    run(sql`ALTER TABLE factory_runs DROP COLUMN triage`);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, started_at) VALUES ('r', 'f', 7, 'working', '2026-01-01')`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '108_factory_runs_triage'`);
    await autoMigrate();

    expect(
      all<{ triage: string | null }>(sql`SELECT triage FROM factory_runs WHERE id = 'r'`),
    ).toEqual([{ triage: null }]);
    run(sql`UPDATE factory_runs SET state = 'needs_info' WHERE id = 'r'`);
    expect(all<{ state: string }>(sql`SELECT state FROM factory_runs WHERE id = 'r'`)).toEqual([
      { state: 'needs_info' },
    ]);
  });
});
