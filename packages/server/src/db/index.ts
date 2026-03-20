/**
 * Central server database connection — SQLite only.
 *
 * Uses the shared connection factory from @funny/shared.
 * Database file lives at ~/.funny/data.db.
 */

import { resolve } from 'path';

import {
  type AppDatabase,
  type DatabaseConnection,
  createSqliteDatabase,
  dbAll as _dbAll,
  dbGet as _dbGet,
  dbRun as _dbRun,
} from '@funny/shared/db/connection';
import { okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import * as schema from './schema.js';

export type { AppDatabase };

let _connection: DatabaseConnection | null = null;

/**
 * Initialize the SQLite database connection.
 * Must be called once at startup before any DB access.
 */
export function initDatabase(options?: {
  /** SQLite path override */
  sqlitePath?: string;
}): ResultAsync<void, string> {
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

export async function closeDatabase(): Promise<void> {
  if (_connection) {
    await _connection.close();
  }
}

// Compat helpers
export const dbMode = 'sqlite';
export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;
