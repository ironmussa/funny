/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 *
 * Database factory — dialect-agnostic.
 * Exports `db`, `schema`, and helpers for backward compatibility.
 *
 * In runner mode (TEAM_SERVER_URL set), the runtime is stateless —
 * no database is created. All data is proxied to the server via WebSocket.
 */

import { resolve } from 'path';

import {
  type AppDatabase,
  type DatabaseConnection,
  type DatabaseProvider,
  type DbDialect,
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

/** The active database dialect (or 'runner' when stateless). */
export const dbDialect: DbDialect | 'runner' = isRunner ? 'runner' : 'sqlite';

let _provider: DatabaseProvider | null = null;
let _legacyConnection: DatabaseConnection | null = null;

// Only create a DB connection when NOT in runner mode
if (!isRunner) {
  const dbPath = resolve(DATA_DIR, 'data.db');
  _legacyConnection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
  _provider = {
    db: _legacyConnection.db,
    schema: _legacyConnection.schema,
    dialect: 'sqlite',
    rawDriver: _legacyConnection.sqlite,
    close: () => _legacyConnection!.close(),
  };
  shutdownManager.register('database', () => _provider!.close(), ShutdownPhase.DATABASE);
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
    if (!_provider) {
      throw new Error('Database not initialized.');
    }
    return (_provider.db as any)[prop];
  },
});

export const schema = sqliteSchema;
export const sqlite = !isRunner ? (_legacyConnection?.sqlite ?? null) : null;

/** @deprecated Use dbDialect instead. */
export const dbMode = isRunner ? ('runner' as string) : 'sqlite';

/** Get the active DatabaseProvider. Null in runner mode. */
export function getProvider(): DatabaseProvider | null {
  return _provider;
}

/** Get the underlying DatabaseConnection. Null in runner mode. */
export function getConnection(): DatabaseConnection | null {
  return _legacyConnection;
}

// ── Compat helpers ──────────────────────────────────────────────

export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;

/** @deprecated Use shutdown manager instead. */
export function closeDatabase() {
  if (_legacyConnection?.sqlite) {
    try {
      _legacyConnection.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    try {
      _legacyConnection.sqlite.close();
      log.info('Database closed', { namespace: 'db' });
    } catch (err) {
      log.warn('Error closing database', { namespace: 'db', error: err });
    }
  }
}
