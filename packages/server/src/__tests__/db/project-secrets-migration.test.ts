/**
 * Migration 103_project_secrets: the table exists, a shared name is unique per
 * project (shared rows carry `user_id = ''`), and rows go with their project.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('103_project_secrets migration', () => {
  test('creates the table with its unique key and project cascade', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    const count = () => db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM project_secrets`)[0].n;

    run(
      sql`INSERT INTO projects (id, name, path, user_id, created_at) VALUES ('p', 'p', '/p', 'u', '2026-01-01')`,
    );
    const insert = (id: string, scope: string, userId: string) =>
      run(
        sql`INSERT INTO project_secrets (id, project_id, scope, user_id, name, ciphertext, updated_by, created_at, updated_at)
            VALUES (${id}, 'p', ${scope}, ${userId}, 'API_KEY', 'c', 'u', '2026-01-01', '2026-01-01')`,
      );
    insert('a', 'project', '');
    insert('b', 'user', 'u');
    insert('c', 'user', 'v');
    expect(() => insert('d', 'project', '')).toThrow();
    expect(() => insert('e', 'user', 'u')).toThrow();
    expect(count()).toBe(3);

    run(sql`PRAGMA foreign_keys = ON`);
    run(sql`DELETE FROM projects WHERE id = 'p'`);
    expect(count()).toBe(0);
  });
});
