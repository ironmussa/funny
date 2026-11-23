/**
 * Migration 109_factory_review_and_merge_policy (change factory-agent-roles):
 * existing factories merge only low-risk changes, and existing runs have no
 * verdict and no risk class.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('109_factory_review_and_merge_policy migration', () => {
  test('adds the review columns and the careful merge policy to existing rows', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind to the pre-109 shape.
    for (const column of ['review_verdicts', 'risk']) {
      run(sql.raw(`ALTER TABLE factory_runs DROP COLUMN ${column}`));
    }
    for (const column of ['auto_merge', 'sensitive_paths', 'stage_limits']) {
      run(sql.raw(`ALTER TABLE factory_settings DROP COLUMN ${column}`));
    }
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, started_at) VALUES ('r', 'f', 7, 'waiting_ci', '2026-01-01')`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '109_factory_review_and_merge_policy'`);
    await autoMigrate();

    expect(
      all<{ auto_merge: string; sensitive_paths: string | null; stage_limits: string | null }>(
        sql`SELECT auto_merge, sensitive_paths, stage_limits FROM factory_settings WHERE id = 'f'`,
      ),
    ).toEqual([{ auto_merge: 'low_risk', sensitive_paths: null, stage_limits: null }]);
    expect(
      all<{ review_verdicts: string | null; risk: string | null; state: string }>(
        sql`SELECT review_verdicts, risk, state FROM factory_runs WHERE id = 'r'`,
      ),
    ).toEqual([{ review_verdicts: null, risk: null, state: 'waiting_ci' }]);

    // The new states are stored like any other.
    run(sql`UPDATE factory_runs SET state = 'merging' WHERE id = 'r'`);
    expect(all<{ state: string }>(sql`SELECT state FROM factory_runs WHERE id = 'r'`)).toEqual([
      { state: 'merging' },
    ]);
  });
});
