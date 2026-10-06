/**
 * Migration 080_disable_automations_for_relaunch (automation-execution):
 * automations enabled before the rollout are disabled once; ones enabled
 * afterwards stay enabled.
 */
import { describe, test, expect } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('080_disable_automations_for_relaunch migration', () => {
  test('disables enabled automations exactly once', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');

    // Simulate a DB from before the rollout: an enabled automation, 080 not applied.
    const now = new Date().toISOString();
    (db as any).run(sql`
      INSERT INTO projects (id, name, path, user_id, created_at)
      VALUES ('p1', 'p1', '/repo', 'u1', ${now})
    `);
    (db as any).run(sql`
      INSERT INTO automations (id, project_id, user_id, name, prompt, schedule, enabled, created_at, updated_at)
      VALUES ('a1', 'p1', 'u1', 'Nightly', 'look', '0 9 * * *', 1, ${now}, ${now})
    `);
    (db as any).run(
      sql`DELETE FROM _migrations WHERE name = '080_disable_automations_for_relaunch'`,
    );
    const enabled = () =>
      ((db as any).all(sql`SELECT enabled FROM automations WHERE id = 'a1'`) as any[])[0].enabled;

    await autoMigrate();
    expect(enabled()).toBe(0);

    // The owner re-enables it; later startups leave it alone.
    (db as any).run(sql`UPDATE automations SET enabled = 1 WHERE id = 'a1'`);
    await autoMigrate();
    expect(enabled()).toBe(1);
  });
});
