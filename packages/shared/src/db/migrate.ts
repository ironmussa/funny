/**
 * Shared migration infrastructure — dialect-agnostic.
 *
 * Provides helpers and a migration runner.
 * Each package defines its own migrations array and calls `runMigrations()`.
 */

import { sql } from 'drizzle-orm';

import type { DbDialect } from './provider.js';

// ── Types ────────────────────────────────────────────────────────

export interface Migration {
  name: string;
  up: () => Promise<void>;
}

export interface MigrationContext {
  /** Execute a SQL statement (CREATE, ALTER, INSERT, etc.) */
  exec: (query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>) => Promise<void>;
  /** Query a single row */
  queryOne: <T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ) => Promise<T | undefined>;
  /** Safely add a column (idempotent) */
  addColumn: (table: string, column: string, type: string, dflt?: string) => Promise<void>;
  /** The active dialect — migrations can use this to emit dialect-specific SQL. */
  dialect: DbDialect;
}

export interface MigrationLogger {
  info: (msg: string, meta?: any) => void;
  error: (msg: string, meta?: any) => void;
}

// ── Context factory ──────────────────────────────────────────────

/**
 * Create a migration context from a Drizzle database instance.
 *
 * @param db    Drizzle database instance (SQLite or PostgreSQL)
 * @param dialect  The active database dialect (defaults to 'sqlite' for backward compat)
 */
export function createMigrationContext(db: any, dialect: DbDialect = 'sqlite'): MigrationContext {
  if (dialect === 'pg') {
    return createPgMigrationContext(db);
  }
  return createSqliteMigrationContext(db);
}

function createSqliteMigrationContext(db: any): MigrationContext {
  function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
    db.run(query);
    return Promise.resolve();
  }

  function queryOne<T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ): Promise<T | undefined> {
    return Promise.resolve(db.get<T>(query));
  }

  async function addColumn(table: string, column: string, type: string, dflt?: string) {
    try {
      const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
      await exec(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`));
    } catch {
      // Column already exists (SQLite doesn't support IF NOT EXISTS for ADD COLUMN)
    }
  }

  return { exec, queryOne, addColumn, dialect: 'sqlite' };
}

function createPgMigrationContext(db: any): MigrationContext {
  async function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
    await db.execute(query);
  }

  async function queryOne<T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ): Promise<T | undefined> {
    const rows = await db.execute(query);
    return rows?.[0] as T | undefined;
  }

  async function addColumn(table: string, column: string, type: string, dflt?: string) {
    // PostgreSQL supports IF NOT EXISTS natively
    const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
    await exec(
      sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}${defaultClause}`),
    );
  }

  return { exec, queryOne, addColumn, dialect: 'pg' };
}

// ── Migration runner ─────────────────────────────────────────────

/**
 * Run a list of migrations against the database.
 *
 * Creates the `_migrations` tracking table if needed, then applies
 * each migration that hasn't been run yet (in order).
 *
 * @param db          Drizzle database instance
 * @param migrations  Ordered list of migrations to apply
 * @param log         Logger for info/error messages
 * @param label       Log namespace label
 * @param dialect     Database dialect (defaults to 'sqlite' for backward compat)
 */
export async function runMigrations(
  db: any,
  migrations: Migration[],
  log: MigrationLogger,
  label: string = 'db',
  dialect: DbDialect = 'sqlite',
): Promise<void> {
  const ctx = createMigrationContext(db, dialect);

  // Ensure migration tracking table exists
  await ctx.exec(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  let applied = 0;

  for (const migration of migrations) {
    // Check if already applied
    const row = await ctx.queryOne<{ name: string }>(
      sql`SELECT name FROM _migrations WHERE name = ${migration.name}`,
    );
    if (row) continue;

    try {
      await migration.up();
      await ctx.exec(
        sql`INSERT INTO _migrations (name, applied_at) VALUES (${migration.name}, ${new Date().toISOString()})`,
      );
      applied++;
    } catch (err) {
      log.error(`Migration ${migration.name} failed`, { namespace: label, error: err });
      throw err;
    }
  }

  if (applied > 0) {
    log.info(`Applied ${applied} migration(s)`, { namespace: label });
  }
  log.info('Tables ready', { namespace: label });
}

// Re-export sql for use in migration definitions
export { sql };
