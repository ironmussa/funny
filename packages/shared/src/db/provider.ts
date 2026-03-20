/**
 * Dialect-agnostic database provider interface.
 *
 * All packages consume the database through this interface — never through
 * dialect-specific modules directly. This enables swapping SQLite for
 * PostgreSQL (or any other engine) without touching application code.
 */

/** Supported database dialects. */
export type DbDialect = 'sqlite' | 'pg';

/**
 * A fully-initialised database connection that hides the underlying dialect.
 *
 * `db` is a Drizzle ORM instance — callers build queries with Drizzle
 * operators as usual. `schema` contains the table references for the
 * active dialect so Drizzle can resolve column metadata.
 */
export interface DatabaseProvider {
  /** Drizzle ORM instance (BunSQLiteDatabase | PostgresJsDatabase) */
  readonly db: any;
  /** Table definitions for the active dialect */
  readonly schema: any;
  /** Which dialect is active */
  readonly dialect: DbDialect;
  /** Raw driver handle (SQLite Database | pg Pool) — for diagnostics only */
  readonly rawDriver: unknown;
  /** Cleanup: close connections, clear timers */
  close(): Promise<void>;
}

/**
 * Thin async wrappers that smooth over the sync (SQLite) vs async (PG)
 * difference in Drizzle's query execution.
 */
export interface DatabaseHelpers {
  /** Execute a SELECT query and return all rows. */
  dbAll<T = any>(query: any): Promise<T[]>;
  /** Execute a SELECT query and return the first row (or undefined). */
  dbGet<T = any>(query: any): Promise<T | undefined>;
  /** Execute a mutation query (INSERT / UPDATE / DELETE). */
  dbRun(query: any): Promise<void>;
}
