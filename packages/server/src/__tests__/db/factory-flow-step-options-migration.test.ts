/**
 * Migration 113_factory_flow_step_options (change factory-flow-step-options,
 * task 3.3): runs from before have no flow source, commit or step options, and
 * factories have no step overrides; what is stored there reads back.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('113_factory_flow_step_options migration', () => {
  test('adds nullable flow and step columns, existing rows read as unknown', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind to the pre-113 shape.
    for (const column of ['flow_source', 'flow_commit', 'step_options']) {
      run(sql.raw(`ALTER TABLE factory_runs DROP COLUMN ${column}`));
    }
    run(sql.raw('ALTER TABLE factory_settings DROP COLUMN step_overrides'));
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, started_at) VALUES ('r', 'f', 7, 'working', '2026-01-01')`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '113_factory_flow_step_options'`);
    await autoMigrate();

    expect(
      all<{ flow_source: string | null; flow_commit: string | null; step_options: string | null }>(
        sql`SELECT flow_source, flow_commit, step_options FROM factory_runs WHERE id = 'r'`,
      ),
    ).toEqual([{ flow_source: null, flow_commit: null, step_options: null }]);
    expect(
      all<{ step_overrides: string | null }>(
        sql`SELECT step_overrides FROM factory_settings WHERE id = 'f'`,
      ),
    ).toEqual([{ step_overrides: null }]);

    run(
      sql`UPDATE factory_runs SET flow_source = 'repository', flow_commit = 'abc1234' WHERE id = 'r'`,
    );
    expect(
      all<{ flow_source: string; flow_commit: string }>(
        sql`SELECT flow_source, flow_commit FROM factory_runs WHERE id = 'r'`,
      ),
    ).toEqual([{ flow_source: 'repository', flow_commit: 'abc1234' }]);
  });
});
