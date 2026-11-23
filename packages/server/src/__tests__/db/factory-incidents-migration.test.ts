/**
 * Migration 109_factory_incidents (change factory-agent-roles, D10): the
 * incidents table and the index that allows one incident that is not closed
 * per repository and base branch.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('109_factory_incidents migration', () => {
  test('creates the table, and refuses a second open incident for the same base branch', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind and run it again: it is what creates the table.
    run(sql`DROP TABLE factory_incidents`);
    run(sql`DELETE FROM _migrations WHERE name = '109_factory_incidents'`);
    await autoMigrate();

    const insert = (id: string, branch: string, state: string) =>
      run(
        sql`INSERT INTO factory_incidents (id, repo, base_branch, state, red_sha, candidates, opened_by_factory, opened_at)
            VALUES (${id}, 'o/r', ${branch}, ${state}, 'abc', '[]', 'f1', '2026-11-22')`,
      );
    insert('i1', 'main', 'open');
    expect(() => insert('i2', 'main', 'investigating')).toThrow();
    // Another base branch has its own, and a closed one does not count.
    insert('i3', 'release', 'open');
    run(sql`UPDATE factory_incidents SET state = 'closed' WHERE id = 'i1'`);
    insert('i4', 'main', 'open');
    expect(
      all<{ id: string }>(sql`SELECT id FROM factory_incidents ORDER BY id`).map((row) => row.id),
    ).toEqual(['i1', 'i3', 'i4']);
  });
});
