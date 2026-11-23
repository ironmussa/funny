/**
 * Migration 114_factory_batches (openspec factory-integration, D2): the batch
 * and attempt tables, and the index that allows one batch that has not ended
 * per repository and base branch.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('114_factory_batches migration', () => {
  test('creates the tables, and refuses a second active batch for the same base branch', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);

    // Rewind and run it again: it is what creates the tables.
    run(sql`DROP TABLE factory_batch_attempts`);
    run(sql`DROP TABLE factory_batches`);
    run(sql`DELETE FROM _migrations WHERE name = '114_factory_batches'`);
    await autoMigrate();

    const insert = (id: string, branch: string, ended: string | null) =>
      run(
        sql`INSERT INTO factory_batches (id, repo, base_branch, leader_run_id, members, staging_branch, queue_branch, created_at, updated_at, ended_at)
            VALUES (${id}, 'o/r', ${branch}, 'r1', '[]', 's', 'q', '2026-11-23', '2026-11-23', ${ended})`,
      );
    insert('b1', 'main', null);
    expect(() => insert('b2', 'main', null)).toThrow();
    // Another base branch has its own, and an ended one does not count.
    insert('b3', 'release', null);
    run(sql`UPDATE factory_batches SET ended_at = '2026-11-23' WHERE id = 'b1'`);
    insert('b4', 'main', null);
    // Attempts go with their batch.
    run(
      sql`INSERT INTO factory_batch_attempts (id, batch_id, members, branch, created_at)
          VALUES ('a1', 'b4', '[]', 'q-a', '2026-11-23')`,
    );
    run(sql`DELETE FROM factory_batches WHERE id = 'b4'`);
    expect(db.all(sql`SELECT id FROM factory_batch_attempts`)).toEqual([]);
  });
});
