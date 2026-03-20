/**
 * Database connection factory — SQLite only.
 *
 * Uses Bun's native SQLite driver with WAL mode, foreign keys, and periodic checkpointing.
 */

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import * as sqliteSchema from './schema.sqlite.js';

// Use the SQLite schema as the canonical type shape
export type AppDatabase = BunSQLiteDatabase<typeof sqliteSchema>;

export interface DatabaseConnection {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  /** Raw SQLite instance */
  sqlite: import('bun:sqlite').Database | null;
  mode: 'sqlite';
  /** Cleanup: close connections, clear timers */
  close(): Promise<void>;
}

export interface CreateSqliteOptions {
  mode: 'sqlite';
  /** Absolute path to the .db file */
  path: string;
  /** Optional logger for warnings/info */
  log?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

const noop = { info: () => {}, warn: () => {} };

/**
 * Create a SQLite database connection with WAL mode, foreign keys, and periodic checkpointing.
 */
export function createSqliteDatabase(options: CreateSqliteOptions): DatabaseConnection {
  // Dynamic import to avoid errors when bun:sqlite is not available
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
  const { drizzle } = require('drizzle-orm/bun-sqlite') as typeof import('drizzle-orm/bun-sqlite');

  const logger = options.log ?? noop;
  const sqliteDb = new Database(options.path);

  sqliteDb.exec('PRAGMA journal_mode = WAL');
  sqliteDb.exec('PRAGMA foreign_keys = ON');

  const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const walCheckpointTimer = setInterval(() => {
    try {
      sqliteDb.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch (err) {
      logger.warn('WAL checkpoint failed', { namespace: 'db', error: err });
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  if (walCheckpointTimer.unref) walCheckpointTimer.unref();

  const db = drizzle(sqliteDb, { schema: sqliteSchema }) as AppDatabase;

  return {
    db,
    schema: sqliteSchema,
    sqlite: sqliteDb,
    mode: 'sqlite',
    async close() {
      clearInterval(walCheckpointTimer);
      try {
        sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {}
      try {
        sqliteDb.close();
        logger.info('Database closed', { namespace: 'db' });
      } catch (err) {
        logger.warn('Error closing database', { namespace: 'db', error: err });
      }
    },
  };
}

// ── Compat helpers (work with SQLite sync API) ──

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
