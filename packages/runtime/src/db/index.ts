/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 *
 * Database factory — SQLite only.
 * Exports `db`, `schema`, and `sqlite` for backward compatibility.
 *
 * In runner mode (TEAM_SERVER_URL set), the runtime is stateless —
 * no database is created. All data is proxied to the server via WebSocket.
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
import * as sqliteSchema from '@funny/shared/db/schema-sqlite';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';

export type { AppDatabase, DatabaseConnection };

// ── Runner mode: completely stateless, no DB ────────────────────
const isRunner = !!process.env.TEAM_SERVER_URL;

let _connection: DatabaseConnection | null = null;

// Only create a DB connection when NOT in runner mode
if (!isRunner) {
  const dbPath = resolve(DATA_DIR, 'data.db');
  _connection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
  shutdownManager.register('database', () => _connection!.close(), ShutdownPhase.DATABASE);
}

// ── Exports ─────────────────────────────────────────────────────

/** The Drizzle database instance. Throws in runner mode (no DB). */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (isRunner) {
      throw new Error(
        'Database not available in runner mode (stateless). Data is proxied to the server.',
      );
    }
    if (!_connection) {
      throw new Error('Database not initialized.');
    }
    return (_connection.db as any)[prop];
  },
});

export const schema = sqliteSchema;
export const sqlite = !isRunner ? (_connection?.sqlite ?? null) : null;
export const dbMode = isRunner ? ('runner' as string) : 'sqlite';

/** Get the underlying DatabaseConnection. Null in runner mode. */
export function getConnection(): DatabaseConnection | null {
  return _connection;
}

// ── Compat helpers ──────────────────────────────────────────────

export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;

/** @deprecated Use shutdown manager instead. */
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
