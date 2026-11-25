/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 *
 * Database factory — dialect-agnostic.
 * Exports `db` and helpers for backward compatibility.
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
  dbRun as _dbRun,
} from '@funny/shared/db/connection';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';

export type { AppDatabase, DatabaseConnection };

// ── Runner mode: completely stateless, no DB ────────────────────
const isRunner = !!process.env.TEAM_SERVER_URL;

/** The active database dialect (or 'runner' when stateless). */
export const dbDialect: DbDialect | 'runner' = isRunner ? 'runner' : 'sqlite';

let providerInstance: DatabaseProvider | null = null;
let legacyConnection: DatabaseConnection | null = null;

// Only create a DB connection when NOT in runner mode
if (!isRunner) {
  const dbPath = resolve(DATA_DIR, 'data.db');
  legacyConnection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
  providerInstance = {
    db: legacyConnection.db,
    schema: legacyConnection.schema,
    dialect: 'sqlite',
    rawDriver: legacyConnection.sqlite,
    close: () => legacyConnection!.close(),
  };
  shutdownManager.register('database', () => providerInstance!.close(), ShutdownPhase.DATABASE);
}

// ── Exports ─────────────────────────────────────────────────────

/** The Drizzle database instance. Throws in runner mode (no DB). */
// SAFETY: the empty object is only the Proxy target; every property read goes
// through the `get` trap below, which reads the live connection or throws.
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (isRunner) {
      throw new Error(
        'Database not available in runner mode (stateless). Data is proxied to the server.',
      );
    }
    if (!providerInstance) {
      throw new Error('Database not initialized.');
    }
    // SAFETY: the trap forwards every property name (symbols included) to the
    // live Drizzle instance, which is the AppDatabase the target stands for.
    return (providerInstance.db as any)[prop];
  },
});

/** Get the underlying DatabaseConnection. Null in runner mode. */
export function getConnection(): DatabaseConnection | null {
  return legacyConnection;
}

// ── Compat helpers ──────────────────────────────────────────────

export const dbRun = _dbRun;
