/**
 * Guardrail: every foreign key column must lead an index (or the primary key).
 * Without one, lookups by that column scan the table and every ON DELETE
 * CASCADE from the parent scans the whole child table. Migration 089 closed
 * the gaps that existed; this keeps new tables from reopening them.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

let raw: import('bun:sqlite').Database;

beforeAll(async () => {
  const { initDatabase, db } = await import('../../db/index.js');
  await initDatabase({ sqlitePath: ':memory:' });
  const { autoMigrate } = await import('../../db/migrate.js');
  await autoMigrate();
  raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
});

type Row = Record<string, unknown>;

function leadingIndexColumns(table: string): string[] {
  const indexes = raw.query(`PRAGMA index_list("${table}")`).all() as Row[];
  const leading = indexes
    .map((i) => (raw.query(`PRAGMA index_info("${i.name}")`).all() as Row[])[0]?.name)
    .filter((c): c is string => typeof c === 'string');
  const pk = (raw.query(`PRAGMA table_info("${table}")`).all() as Row[])
    .filter((c) => Number(c.pk) === 1)
    .map((c) => String(c.name));
  return [...leading, ...pk];
}

describe('database schema', () => {
  test('every foreign key column is indexed', () => {
    const tables = (
      raw
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Row[]
    ).map((r) => String(r.name));

    const unindexed: string[] = [];
    for (const table of tables) {
      const covered = new Set(leadingIndexColumns(table));
      for (const fk of raw.query(`PRAGMA foreign_key_list("${table}")`).all() as Row[]) {
        if (!covered.has(String(fk.from))) unindexed.push(`${table}.${fk.from} -> ${fk.table}`);
      }
    }
    expect(unindexed).toEqual([]);
  });

  test('thread lookups by session and external request use an index', () => {
    for (const column of ['session_id', 'external_request_id']) {
      const plan = (
        raw.query(`EXPLAIN QUERY PLAN SELECT * FROM threads WHERE ${column} = ?`).all('x') as Row[]
      )
        .map((r) => String(r.detail))
        .join(' ');
      expect(plan).toContain('USING INDEX');
    }
  });
});
