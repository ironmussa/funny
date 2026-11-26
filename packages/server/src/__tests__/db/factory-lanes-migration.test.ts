/**
 * Migrations 137_factory_runs_base_branch and 138_factory_lanes (change
 * factory-lanes): a run records its base branch and its merge commit, a
 * factory has its lane prefixes, and a factory has one lane per name.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('factory-lanes migrations', () => {
  test('add the run columns, the prefixes and the lanes table with one lane per name', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind 138 and run it again: it is what creates the table.
    run(sql`DROP TABLE factory_lanes`);
    run(sql`DELETE FROM _migrations WHERE name = '138_factory_lanes'`);
    await autoMigrate();

    const columns = (table: string) =>
      all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`)).map((row) => row.name);
    expect(columns('factory_runs')).toEqual(
      expect.arrayContaining(['base_branch', 'lane', 'merge_sha']),
    );
    expect(columns('factory_settings')).toEqual(
      expect.arrayContaining(['lane_label_prefix', 'lane_branch_prefix']),
    );

    run(sql`PRAGMA foreign_keys = OFF`);
    const insert = (id: string, factory: string, name: string) =>
      run(
        sql`INSERT INTO factory_lanes (id, factory_id, name, branch, created_at)
            VALUES (${id}, ${factory}, ${name}, ${`feature/${name}`}, '2026-11-26')`,
      );
    insert('l1', 'f1', 'payments');
    expect(() => insert('l2', 'f1', 'payments')).toThrow();
    // Another factory may have a lane of the same name.
    insert('l3', 'f2', 'payments');
    expect(
      all<{ state: string; sync_state: string; sync_attempts: number }>(
        sql`SELECT state, sync_state, sync_attempts FROM factory_lanes WHERE id = 'l1'`,
      ),
    ).toEqual([{ state: 'active', sync_state: 'idle', sync_attempts: 0 }]);
  });

  test('141 keeps `feature:` / `feature/` on existing factories, and new ones read `lane:` / `lane/`', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    run(sql`PRAGMA foreign_keys = OFF`);
    const insert = (id: string, label: string | null) =>
      run(
        sql`INSERT INTO factory_settings (id, project_id, user_id, enabled, created_at, updated_at, lane_label_prefix)
            VALUES (${id}, ${`p-${id}`}, 'u1', 1, '2026-11-26', '2026-11-26', ${label})`,
      );
    insert('old', null);
    insert('custom', 'epic:');
    run(sql`DELETE FROM _migrations WHERE name = '141_factory_lane_prefix_defaults'`);
    await autoMigrate();
    insert('new', null);

    const prefixes = all<{ id: string; label: string | null; branch: string | null }>(
      sql`SELECT id, lane_label_prefix AS label, lane_branch_prefix AS branch
          FROM factory_settings ORDER BY id`,
    );
    expect(prefixes).toEqual([
      { id: 'custom', label: 'epic:', branch: 'feature/' },
      { id: 'new', label: null, branch: null },
      { id: 'old', label: 'feature:', branch: 'feature/' },
    ]);
    const { DEFAULT_LANE_BRANCH_PREFIX, DEFAULT_LANE_LABEL_PREFIX } =
      await import('@funny/shared/contracts/factory');
    expect([DEFAULT_LANE_LABEL_PREFIX, DEFAULT_LANE_BRANCH_PREFIX]).toEqual(['lane:', 'lane/']);
  });
});
