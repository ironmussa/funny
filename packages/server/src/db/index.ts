/**
 * Central server database connection — dialect-agnostic.
 *
 * Resolves the database dialect at startup:
 *   - `DATABASE_URL` env var present → PostgreSQL
 *   - Otherwise → SQLite at ~/.funny/data.db
 *
 * Exports `db` and `schema` as lazy Proxies so the 22+ consumer files
 * that import from this module require zero changes.
 */

import { resolve } from 'path';

import {
  type AppDatabase,
  type DatabaseConnection,
  type DatabaseProvider,
  type DbDialect,
  createDatabase,
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

// ── Dialect resolution ───────────────────────────────────────────

/** The active database dialect for this server instance. */
export const dbDialect: DbDialect = process.env.DATABASE_URL ? 'pg' : 'sqlite';

let _provider: DatabaseProvider | null = null;

// Legacy compat — kept so `getConnection()` / `setConnection()` callers
// (middleware/auth.ts, server/index.ts) continue to work.
let _legacyConnection: DatabaseConnection | null = null;

// ── Initialization ───────────────────────────────────────────────

/**
 * Initialize the database connection.
 * Must be called once at startup before any DB access.
 */
export function initDatabase(options?: {
  /** SQLite path override (ignored when DATABASE_URL is set) */
  sqlitePath?: string;
}): ResultAsync<void, string> {
  if (dbDialect === 'pg') {
    _provider = createDatabase({
      dialect: 'pg',
      connectionString: process.env.DATABASE_URL!,
      log,
    });
  } else {
    const dbPath = options?.sqlitePath ?? resolve(DATA_DIR, 'data.db');
    // Use the legacy wrapper so _legacyConnection stays populated
    _legacyConnection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
    _provider = {
      db: _legacyConnection.db,
      schema: _legacyConnection.schema,
      dialect: 'sqlite',
      rawDriver: _legacyConnection.sqlite,
      close: () => _legacyConnection!.close(),
    };
  }
  return okAsync(undefined);
}

// ── Lazy Proxies ─────────────────────────────────────────────────

/** The Drizzle database instance. `initDatabase()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (!_provider) {
      throw new Error('Database not initialized. Call initDatabase() at startup.');
    }
    return (_provider.db as any)[prop];
  },
});

export { schema };

// ── Provider access ──────────────────────────────────────────────

/** Get the active DatabaseProvider. Null before initDatabase(). */
export function getProvider(): DatabaseProvider | null {
  return _provider;
}

/**
 * Get the underlying DatabaseConnection (legacy API).
 * Returns null when using PostgreSQL (no legacy connection).
 */
export function getConnection(): DatabaseConnection | null {
  return _legacyConnection;
}

/** Set a pre-existing connection (e.g. shared from runtime in local mode). */
export function setConnection(conn: DatabaseConnection): void {
  _legacyConnection = conn;
  _provider = {
    db: conn.db,
    schema: conn.schema,
    dialect: 'sqlite',
    rawDriver: conn.sqlite,
    close: () => conn.close(),
  };
}

export async function closeDatabase(): Promise<void> {
  if (_provider) {
    await _provider.close();
  }
}

// ── Compat helpers ───────────────────────────────────────────────

/** @deprecated Use dbDialect instead. */
export const dbMode: string = dbDialect;
export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;
