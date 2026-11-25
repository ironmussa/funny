/**
 * Migration 127_factory_approval_requests (openspec factory-agent-tools): the
 * requests table and the index that allows one pending request per run.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('127_factory_approval_requests migration', () => {
  test('creates the table, and refuses a second pending request for the same run', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const all = <T>(q: ReturnType<typeof sql>) => db.all<T>(q);

    // Rewind and run it again: it is what creates the table.
    run(sql`DROP TABLE factory_approval_requests`);
    run(sql`DELETE FROM _migrations WHERE name = '127_factory_approval_requests'`);
    await autoMigrate();

    const insert = (id: string, runId: string, state: string) =>
      run(
        sql`INSERT INTO factory_approval_requests (id, run_id, factory_id, project_id, thread_id, sha, state, created_at)
            VALUES (${id}, ${runId}, 'f1', 'p1', 't1', 'abc1234', ${state}, '2026-11-24')`,
      );
    insert('q1', 'r1', 'pending');
    expect(() => insert('q2', 'r1', 'pending')).toThrow();
    // Another run has its own, and a closed one does not count.
    insert('q3', 'r2', 'pending');
    run(sql`UPDATE factory_approval_requests SET state = 'expired' WHERE id = 'q1'`);
    insert('q4', 'r1', 'pending');
    expect(
      all<{ id: string }>(sql`SELECT id FROM factory_approval_requests ORDER BY id`).map(
        (row) => row.id,
      ),
    ).toEqual(['q1', 'q3', 'q4']);
  });
});
