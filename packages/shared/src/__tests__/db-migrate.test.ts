import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { createMigrationContext, type Migration, runMigrations } from '../db/migrate.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  return db;
}

const silentLogger = { info: () => {}, error: () => {} };

function appliedNames(db: any): string[] {
  const rows = db.all(sql`SELECT name FROM _migrations ORDER BY name`) as { name: string }[];
  return rows.map((r) => r.name);
}

describe('addColumn (sqlite)', () => {
  test('tolerates a duplicate column on re-run', async () => {
    const db = makeDb();
    db.run(sql`CREATE TABLE t (id TEXT)`);
    const ctx = createMigrationContext(db, 'sqlite');

    await ctx.addColumn('t', 'a', 'TEXT');
    // Second call hits "duplicate column name" — must be swallowed, not thrown.
    await expect(ctx.addColumn('t', 'a', 'TEXT')).resolves.toBeUndefined();
  });

  test('re-raises a real failure instead of swallowing it', async () => {
    const db = makeDb();
    const ctx = createMigrationContext(db, 'sqlite');
    // ALTER on a missing table is NOT a duplicate column — it must throw so the
    // caller (a migration) fails loudly rather than being recorded as applied.
    await expect(ctx.addColumn('does_not_exist', 'a', 'TEXT')).rejects.toThrow();
  });
});

describe('runMigrations — half-applied guard', () => {
  test('a migration that fails midway is not recorded and retries next run', async () => {
    const db = makeDb();
    db.run(sql`CREATE TABLE t (id TEXT)`);

    // First column succeeds, second targets a missing table → up() throws.
    // Regression: the old addColumn swallowed the second failure, so up()
    // "succeeded" and the migration was recorded with a column it never added.
    let secondTargetExists = false;
    const migration: Migration = {
      name: '001_two_columns',
      async up() {
        const ctx = createMigrationContext(db, 'sqlite');
        await ctx.addColumn('t', 'a', 'TEXT');
        await ctx.addColumn(secondTargetExists ? 't' : 'missing', 'b', 'TEXT');
      },
    };

    await expect(runMigrations(db, [migration], silentLogger, 'test')).rejects.toThrow();
    // Not recorded → will be retried on the next boot.
    expect(appliedNames(db)).not.toContain('001_two_columns');

    // The environment heals (e.g. the column's target now exists); re-run completes.
    secondTargetExists = true;
    await runMigrations(db, [migration], silentLogger, 'test');
    expect(appliedNames(db)).toContain('001_two_columns');

    const cols = (db.all(sql`PRAGMA table_info(t)`) as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('a');
    expect(cols).toContain('b');
  });
});
