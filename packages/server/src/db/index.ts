/**
 * Central server database connection.
 *
 * Uses the shared connection factory from @funny/shared.
 * In multi mode, defaults to PostgreSQL. In local mode, can use SQLite.
 */

import { resolve } from 'path';

import {
  type AppDatabase,
  type DatabaseConnection,
  createSqliteDatabase,
  createPostgresDatabase,
  dbAll as _dbAll,
  dbGet as _dbGet,
  dbRun as _dbRun,
} from '@funny/shared/db/connection';
import { getDbMode, getDatabaseUrl } from '@funny/shared/db/db-mode';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import * as schema from './schema.js';

export type { AppDatabase };

let _connection: DatabaseConnection | null = null;

/**
 * Initialize the database connection.
 * Must be called once at startup before any DB access.
 *
 * Auto-detects mode via getDbMode():
 * - SQLite (default): uses ~/.funny/data.db
 * - PostgreSQL: uses DATABASE_URL or DB_HOST + DB_USER env vars
 */
export function initDatabase(options?: {
  /** Override mode detection */
  mode?: 'sqlite' | 'postgres';
  /** SQLite path (only for sqlite mode) */
  sqlitePath?: string;
  /** PostgreSQL URL (only for postgres mode) */
  postgresUrl?: string;
}): ResultAsync<void, string> {
  const mode = options?.mode ?? getDbMode();

  if (mode === 'postgres') {
    const url = options?.postgresUrl ?? getDatabaseUrl();
    if (!url) {
      return errAsync(
        'DB_MODE is set to "postgres" but no database credentials were found.\n' +
          '  Set DATABASE_URL in your .env file, for example:\n' +
          '    DATABASE_URL=postgresql://user:password@host:5432/dbname\n' +
          '  Or switch back to SQLite by setting DB_MODE=sqlite.',
      );
    }
    return ResultAsync.fromPromise(
      createPostgresDatabase({ mode: 'postgres', url, log }).then((conn) => {
        _connection = conn;
      }),
      (e) => `Failed to connect to PostgreSQL: ${e}`,
    );
  }

  const dbPath = options?.sqlitePath ?? resolve(DATA_DIR, 'data.db');
  _connection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
  return okAsync(undefined);
}

/** The Drizzle database instance. `initDatabase()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (!_connection) {
      throw new Error('Database not initialized. Call initDatabase() at startup.');
    }
    return (_connection.db as any)[prop];
  },
});

export { schema };

/** Get the underlying DatabaseConnection. */
export function getConnection(): DatabaseConnection | null {
  return _connection;
}

/** Set a pre-existing connection (e.g. shared from runtime in local mode). */
export function setConnection(conn: DatabaseConnection): void {
  _connection = conn;
}

/** The raw SQL client for use with adapters that need it (e.g. Better Auth). */
export function getRawClient(): any | null {
  return _connection?.pgClient ?? null;
}

export async function closeDatabase(): Promise<void> {
  if (_connection) {
    await _connection.close();
  }
}

// Compat helpers
export const dbMode = getDbMode();
export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;
