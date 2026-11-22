import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { createMigrationContext, type Migration, runMigrations } from '../db/migrate.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  return db;
}

const silentLogger = { info: () => {}, error: () => {} };

function appliedNames(db: ReturnType<typeof makeDb>): string[] {
  const rows = db.all<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY name`);
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

    const cols = db.all<{ name: string }>(sql`PRAGMA table_info(t)`).map((c) => c.name);
    expect(cols).toContain('a');
    expect(cols).toContain('b');
  });
});

describe('runMigrations — applied lookup', () => {
  test('reads applied migrations with one query and runs only the new ones', async () => {
    const db = makeDb();
    const ran: string[] = [];
    const migrations: Migration[] = ['001_a', '002_b', '003_c'].map((name) => ({
      name,
      async up() {
        ran.push(name);
      },
    }));

    await runMigrations(db, migrations.slice(0, 2), silentLogger, 'test');
    expect(ran).toEqual(['001_a', '002_b']);

    const lookups: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy get trap forwards the read.
        const value = Reflect.get(target, prop, receiver);
        if ((prop === 'get' || prop === 'all') && typeof value === 'function') {
          return (query: any) => {
            lookups.push(String(prop));
            return value.call(target, query);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await runMigrations(spy, migrations, silentLogger, 'test');
    expect(ran).toEqual(['001_a', '002_b', '003_c']);
    expect(appliedNames(db)).toEqual(['001_a', '002_b', '003_c']);
    // One lookup for all applied migrations, then one re-check under the lock
    // for the single pending migration only, not one `get` per migration.
    expect(lookups).toEqual(['all', 'get']);
  });
});

describe('runMigrations — transaction (sqlite)', () => {
  test('rolls back the statements of a migration that fails midway', async () => {
    const db = makeDb();
    db.run(sql`CREATE TABLE t (id TEXT)`);
    const migration: Migration = {
      name: '001_half',
      async up() {
        const ctx = createMigrationContext(db, 'sqlite');
        await ctx.addColumn('t', 'a', 'TEXT');
        await ctx.addColumn('missing', 'b', 'TEXT');
      },
    };

    await expect(runMigrations(db, [migration], silentLogger, 'test')).rejects.toThrow();
    const cols = db.all<{ name: string }>(sql`PRAGMA table_info(t)`).map((c) => c.name);
    expect(cols).not.toContain('a');
    expect(appliedNames(db)).toEqual([]);
  });

  test('skips a migration another instance applied after the first lookup', async () => {
    const db = makeDb();
    let ranSecond = false;
    const migrations: Migration[] = [
      {
        name: '001_first',
        async up() {
          // Another instance records 002 while this one works on 001.
          db.run(sql`INSERT INTO _migrations (name, applied_at) VALUES ('002_second', 'x')`);
        },
      },
      {
        name: '002_second',
        async up() {
          ranSecond = true;
        },
      },
    ];

    await runMigrations(db, migrations, silentLogger, 'test');
    expect(ranSecond).toBe(false);
    expect(appliedNames(db)).toEqual(['001_first', '002_second']);
  });
});

/**
 * A stand-in for drizzle's node-postgres database: records each statement with
 * the transaction depth it ran at (0 = the pool, 1 = a migration transaction,
 * 2 = a savepoint), and fails the statements `failing` matches.
 */
function makeFakePg(
  options: { applied?: string[]; failing?: RegExp; onLock?: (applied: Set<string>) => void } = {},
) {
  const statements: { text: string; depth: number }[] = [];
  const applied = new Set(options.applied ?? []);
  const dialect = new SQLiteSyncDialect();

  function executor(depth: number) {
    return {
      async execute(query: any) {
        const { sql: text, params } = dialect.sqlToQuery(query);
        statements.push({ text, depth });
        if (options.failing?.test(text)) throw new Error(`failed: ${text}`);
        if (text.includes('pg_advisory_xact_lock')) options.onLock?.(applied);
        if (/^SELECT name FROM _migrations WHERE/.test(text)) {
          return { rows: applied.has(params[0] as string) ? [{ name: params[0] }] : [] };
        }
        if (/^SELECT name FROM _migrations/.test(text)) {
          return { rows: [...applied].map((name) => ({ name })) };
        }
        if (/^INSERT INTO _migrations/.test(text)) applied.add(params[0] as string);
        return { rows: [] };
      },
      async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
        return fn(executor(depth + 1));
      },
    };
  }

  return { db: executor(0), statements };
}

describe('runMigrations — transaction and lock (pg)', () => {
  test('runs each migration in a transaction that takes the advisory lock first', async () => {
    const { db, statements } = makeFakePg();
    const migration: Migration = {
      name: '001_a',
      async up() {
        await createMigrationContext(db, 'pg').exec(sql`CREATE TABLE a (id TEXT)`);
      },
    };

    await runMigrations(db, [migration], silentLogger, 'test', 'pg');

    const inTx = statements.filter((s) => s.depth > 0).map((s) => s.text.trim().split('\n')[0]);
    expect(inTx).toEqual([
      // _migrations table setup
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('CREATE TABLE IF NOT EXISTS _migrations'),
      // 001_a: lock, re-check, the migration's statement, the record
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('SELECT name FROM _migrations WHERE'),
      'CREATE TABLE a (id TEXT)',
      expect.stringContaining('INSERT INTO _migrations'),
    ]);
    // The migration's statement went through the transaction, not the pool.
    expect(statements.find((s) => s.text === 'CREATE TABLE a (id TEXT)')?.depth).toBe(2);
  });

  test('a caught statement failure does not abort the rest of the migration', async () => {
    const { db, statements } = makeFakePg({ failing: /RENAME COLUMN/ });
    const migration: Migration = {
      name: '001_rename',
      async up() {
        const ctx = createMigrationContext(db, 'pg');
        try {
          await ctx.exec(sql`ALTER TABLE t RENAME COLUMN a TO b`);
        } catch {
          // already renamed
        }
        await ctx.exec(sql`CREATE INDEX i ON t (b)`);
      },
    };

    await runMigrations(db, [migration], silentLogger, 'test', 'pg');
    // Each statement ran in its own savepoint, so PostgreSQL rolls back only
    // the failed one and the transaction can go on.
    expect(statements.find((s) => s.text.includes('RENAME'))?.depth).toBe(2);
    expect(statements.some((s) => s.text.startsWith('INSERT INTO _migrations'))).toBe(true);
  });

  test('skips a migration another instance applied while this one waited for the lock', async () => {
    let locks = 0;
    const { db } = makeFakePg({
      // Lock 1 is the table setup; while lock 2 is awaited, another instance
      // applies 001_a.
      onLock: (applied) => {
        locks++;
        if (locks === 2) applied.add('001_a');
      },
    });
    let ran = false;
    const migration: Migration = {
      name: '001_a',
      async up() {
        ran = true;
      },
    };

    await runMigrations(db, [migration], silentLogger, 'test', 'pg');
    expect(ran).toBe(false);
  });
});
