/**
 * Schema drift guard (persistence-schema-consistency).
 *
 * The SQLite and Postgres Drizzle definitions are maintained by hand, and the
 * server migrations by a third hand. When they disagree, data silently changes
 * shape between backends (e.g. `projects.closed` existed on SQLite only, so a
 * closed project reopened on Postgres). This test fails, naming the table and
 * column, when:
 *   1. the two definitions differ in tables, columns, or JS value type;
 *   2. a freshly migrated SQLite database differs from the SQLite definition;
 *   3. a freshly migrated Postgres database differs from the Postgres
 *      definition — run with `DATABASE_URL` pointing at a disposable
 *      Postgres DB (the dialect is chosen from it at startup; the SQLite
 *      check is skipped then).
 */
import { describe, test, expect } from 'bun:test';

import * as pgSchema from '@funny/shared/db/schema-pg';
import * as sqliteSchema from '@funny/shared/db/schema-sqlite';
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig as pgConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { AppDatabase } from '../../db/index.js';

/**
 * Better Auth stores its booleans as integers on SQLite and as native booleans
 * on Postgres; `lib/auth.ts` and migration 061 handle the difference.
 */
const DIALECT_SPECIFIC_TYPES = new Set(['user.banned', 'user.email_verified']);

/**
 * Columns a migrated database still has and the definitions no longer declare:
 * the first half of a two-deploy removal. The code stops reading the column in
 * one deploy and a migration drops it in the next, so a server from before the
 * drop never selects a column that is gone. Remove the entry with that migration.
 */
const PENDING_DROP = new Set<string>();

interface ColumnInfo {
  /** Drizzle's JS value type: 'string' | 'number' | 'boolean' | 'json' | … */
  dataType: string;
}

type ColumnLayout = Record<string, Record<string, ColumnInfo>>;

/** A `customType` column reports 'custom' — infer what it hands to JS instead. */
function valueType(column: { dataType: string; mapFromDriverValue?: (v: unknown) => unknown }) {
  if (column.dataType !== 'custom' || !column.mapFromDriverValue) return column.dataType;
  try {
    return typeof column.mapFromDriverValue(1);
  } catch {
    return 'custom';
  }
}

function layoutOf(mod: Record<string, unknown>, dialect: 'sqlite' | 'pg'): ColumnLayout {
  const layout: ColumnLayout = {};
  for (const value of Object.values(mod)) {
    const config =
      dialect === 'pg'
        ? value instanceof PgTable
          ? pgConfig(value)
          : null
        : value instanceof SQLiteTable
          ? sqliteConfig(value)
          : null;
    if (!config) continue;
    layout[config.name] = Object.fromEntries(
      config.columns.map((c) => [c.name, { dataType: valueType(c) }]),
    );
  }
  return layout;
}

function definitionDrift(a: ColumnLayout, b: ColumnLayout): string[] {
  const problems: string[] = [];
  for (const table of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[table]) problems.push(`table ${table} only in Postgres definition`);
    else if (!b[table]) problems.push(`table ${table} only in SQLite definition`);
    if (!a[table] || !b[table]) continue;
    for (const column of new Set([...Object.keys(a[table]), ...Object.keys(b[table])])) {
      const key = `${table}.${column}`;
      if (!a[table][column]) problems.push(`${key} missing in SQLite definition`);
      else if (!b[table][column]) problems.push(`${key} missing in Postgres definition`);
      else if (
        a[table][column].dataType !== b[table][column].dataType &&
        !DIALECT_SPECIFIC_TYPES.has(key)
      ) {
        problems.push(
          `${key} is ${a[table][column].dataType} on SQLite but ${b[table][column].dataType} on Postgres`,
        );
      }
    }
  }
  return problems.sort();
}

function liveDrift(definition: ColumnLayout, live: Record<string, Set<string>>): string[] {
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(definition)) {
    const liveColumns = live[table];
    if (!liveColumns || liveColumns.size === 0) {
      problems.push(`table ${table} missing in migrated DB`);
      continue;
    }
    for (const column of Object.keys(columns)) {
      if (!liveColumns.has(column)) problems.push(`${table}.${column} missing in migrated DB`);
    }
    for (const column of liveColumns) {
      const key = `${table}.${column}`;
      if (!columns[column] && !PENDING_DROP.has(key)) {
        problems.push(`${key} exists in migrated DB but not in the definition`);
      }
    }
  }
  return problems.sort();
}

/** The Postgres Drizzle handle: the one with `execute()` (the SQLite one has `all()`). */
function isPgDatabase(
  db: AppDatabase,
): db is AppDatabase & { execute(query: SQL): Promise<unknown[]> } {
  return 'execute' in db;
}

const { dbDialect } = await import('../../db/index.js');
const sqliteLayout = layoutOf(sqliteSchema, 'sqlite');
const pgLayout = layoutOf(pgSchema, 'pg');

describe('schema drift', () => {
  test('both definitions declare the same tables, columns and value types', () => {
    expect(Object.keys(sqliteLayout).length).toBeGreaterThan(40);
    expect(definitionDrift(sqliteLayout, pgLayout)).toEqual([]);
  });

  test.skipIf(dbDialect !== 'sqlite')(
    'a freshly migrated SQLite database matches the SQLite definition',
    async () => {
      const { initDatabase } = await import('../../db/index.js');
      await initDatabase({ sqlitePath: ':memory:' });
      const { autoMigrate } = await import('../../db/migrate.js');
      await autoMigrate();
      const { db } = await import('../../db/index.js');

      const live: Record<string, Set<string>> = {};
      for (const table of Object.keys(sqliteLayout)) {
        const rows = db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${table}")`));
        live[table] = new Set(rows.map((r) => r.name));
      }
      expect(liveDrift(sqliteLayout, live)).toEqual([]);
    },
  );

  test.skipIf(dbDialect !== 'pg')(
    'a freshly migrated Postgres database matches the Postgres definition',
    async () => {
      const { initDatabase } = await import('../../db/index.js');
      await initDatabase();
      const { autoMigrate } = await import('../../db/migrate.js');
      await autoMigrate();
      const { db, dbAll } = await import('../../db/index.js');

      // `AppDatabase` is typed after SQLite; with DATABASE_URL set it is the Postgres handle.
      if (!isPgDatabase(db)) throw new Error('expected the Postgres database');
      const rows = await dbAll<{ table_name: string; column_name: string }>(
        db.execute(sql`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
        `),
      );
      const live: Record<string, Set<string>> = {};
      for (const r of rows) (live[r.table_name] ??= new Set()).add(r.column_name);
      expect(liveDrift(pgLayout, live)).toEqual([]);
    },
  );
});
