/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 *
 * Database factory — uses shared connection factory from @funny/shared.
 * Exports `db`, `schema`, and `sqlite` (SQLite-only) for backward compatibility.
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
import { getDbMode } from '@funny/shared/db/db-mode';
import * as sqliteSchema from '@funny/shared/db/schema-sqlite';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';

export type { AppDatabase, DatabaseConnection };

const mode = getDbMode();

let _connection: DatabaseConnection | null = null;

// ── Default SQLite path (synchronous) ───────────────────────────
if (mode === 'sqlite') {
  const dbPath = resolve(DATA_DIR, 'data.db');
  _connection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });

  shutdownManager.register('database', () => _connection!.close(), ShutdownPhase.DATABASE);
}

// ── PostgreSQL initialization (async, must be called at startup) ──
export async function initPostgres(): Promise<void> {
  if (mode !== 'postgres' || _connection) return;

  _connection = await createPostgresDatabase({ mode: 'postgres', log });

  shutdownManager.register('database', () => _connection!.close(), ShutdownPhase.DATABASE);
}

// ── Exports ─────────────────────────────────────────────────────

/** The Drizzle database instance. In Postgres mode, `initPostgres()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (!_connection) {
      throw new Error('Database not initialized. Call initPostgres() at startup (for PG mode).');
    }
    return (_connection.db as any)[prop];
  },
});

export const schema = sqliteSchema;
export const sqlite = mode === 'sqlite' ? (_connection?.sqlite ?? null) : null;
export const dbMode = mode;

/** Get the underlying DatabaseConnection. */
export function getConnection(): DatabaseConnection | null {
  return _connection;
}

// ── Compat helpers ──────────────────────────────────────────────

export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;

/** @deprecated Use shutdown manager instead. Only works in SQLite mode. */
export function closeDatabase() {
  if (_connection?.sqlite) {
    try {
      _connection.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    try {
      _connection.sqlite.close();
      log.info('Database closed', { namespace: 'db' });
    } catch (err) {
      log.warn('Error closing database', { namespace: 'db', error: err });
    }
  }
}
