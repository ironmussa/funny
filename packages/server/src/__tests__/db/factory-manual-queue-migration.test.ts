/**
 * Migration 100_factory_manual_queue: factories that existed before it admitted
 * their label, so they become `automatic`; a factory created after it starts
 * `manual`. Existing runs are label runs with no recorded flow.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('100_factory_manual_queue migration', () => {
  test('existing factories become automatic, new ones start manual', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => (db as any).run(q);
    const all = <T>(q: ReturnType<typeof sql>) => (db as any).all(q) as T[];

    // Rewind to the pre-100 shape.
    for (const column of ['source', 'flow_name', 'queue_order', 'wait_reason', 'admitted_at']) {
      run(sql.raw(`ALTER TABLE factory_runs DROP COLUMN ${column}`));
    }
    run(sql`ALTER TABLE factory_settings DROP COLUMN mode`);
    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at) VALUES ('f', 'p', 'u', 1, '2026-01-01', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_runs (id, factory_id, issue_number, state, started_at) VALUES ('r', 'f', 7, 'working', '2026-01-01')`,
    );

    run(sql`DELETE FROM _migrations WHERE name = '100_factory_manual_queue'`);
    await autoMigrate();

    expect(all<{ mode: string }>(sql`SELECT mode FROM factory_settings WHERE id = 'f'`)).toEqual([
      { mode: 'automatic' },
    ]);
    expect(
      all<{ source: string; flow_name: string | null }>(
        sql`SELECT source, flow_name FROM factory_runs WHERE id = 'r'`,
      ),
    ).toEqual([{ source: 'label', flow_name: null }]);

    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p2', 'p2', '/p2', 'u', '2026-01-01')`,
    );
    run(
      sql`INSERT INTO factory_settings (id, project_id, user_id, created_at, updated_at) VALUES ('g', 'p2', 'u', '2026-01-01', '2026-01-01')`,
    );
    expect(all<{ mode: string }>(sql`SELECT mode FROM factory_settings WHERE id = 'g'`)).toEqual([
      { mode: 'manual' },
    ]);
  });
});
