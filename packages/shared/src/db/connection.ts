/**
 * Database connection factory — dialect-agnostic.
 *
 * Provides a unified `createDatabase()` factory that resolves to the correct
 * adapter (SQLite or PostgreSQL) based on the requested dialect.
 *
 * Also exports the dialect-agnostic query helpers (dbAll, dbGet, dbRun) and
 * backward-compatible types used throughout the codebase.
 */

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { CreatePgOptions } from './adapters/pg.js';
import type { CreateSqliteOptions } from './adapters/sqlite.js';
import type { DatabaseProvider, DbDialect } from './provider.js';
import type * as sqliteSchema from './schema.sqlite.js';

// Re-export provider types for convenience
export type { DatabaseProvider, DbDialect } from './provider.js';

// ── Types (backward-compatible) ──────────────────────────────────

/**
 * Generic application database type.
 * Kept as the SQLite-flavoured Drizzle type for backward compat — callers
 * that only use Drizzle query-builder methods work identically on either dialect.
 */
export type AppDatabase = BunSQLiteDatabase<typeof sqliteSchema>;

/**
 * Legacy connection shape. New code should use `DatabaseProvider` from `provider.ts`.
 * @deprecated Use DatabaseProvider instead.
 */
export interface DatabaseConnection {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  /** Raw SQLite instance (null when dialect is pg) */
  sqlite: import('bun:sqlite').Database | null;
  mode: 'sqlite';
  close(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────

export type CreateDatabaseOptions =
  | ({ dialect: 'sqlite' } & CreateSqliteOptions)
  | ({ dialect: 'pg' } & CreatePgOptions);

/**
 * Create a database provider for the given dialect.
 *
 * This is the preferred entry point — callers get back a `DatabaseProvider`
 * and never need to know which adapter is running underneath.
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseProvider {
  if (options.dialect === 'pg') {
    const { createPgProvider } = require('./adapters/pg.js') as typeof import('./adapters/pg.js');
    return createPgProvider(options);
  }

  const { createSqliteProvider } =
    require('./adapters/sqlite.js') as typeof import('./adapters/sqlite.js');
  return createSqliteProvider(options);
}

// ── Backward-compat wrapper ──────────────────────────────────────

export interface CreateSqliteLegacyOptions {
  mode: 'sqlite';
  path: string;
  log?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

/**
 * Create a SQLite database connection (legacy API).
 * @deprecated Use `createDatabase({ dialect: 'sqlite', path, log })` instead.
 */
export function createSqliteDatabase(options: CreateSqliteLegacyOptions): DatabaseConnection {
  const { createSqliteProvider } =
    require('./adapters/sqlite.js') as typeof import('./adapters/sqlite.js');
  const provider = createSqliteProvider({ path: options.path, log: options.log });

  return {
    db: provider.db as AppDatabase,
    schema: provider.schema,
    sqlite: provider.rawDriver as import('bun:sqlite').Database,
    mode: 'sqlite',
    close: () => provider.close(),
  };
}

// ── Compat helpers (work with both sync SQLite and async PG) ─────

/** Execute a SELECT query and return all rows. */
export async function dbAll<T = any>(query: any): Promise<T[]> {
  if (typeof query.all === 'function') return query.all();
  return query;
}

/** Execute a SELECT query and return the first row. */
export async function dbGet<T = any>(query: any): Promise<T | undefined> {
  if (typeof query.get === 'function') return query.get();
  const rows = await query;
  return rows[0];
}

/** Execute a mutation query (INSERT/UPDATE/DELETE). */
export async function dbRun(query: any): Promise<void> {
  if (typeof query.run === 'function') {
    query.run();
    return;
  }
  await query;
}
