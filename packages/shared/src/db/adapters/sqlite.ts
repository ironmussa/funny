/**
 * SQLite database adapter.
 *
 * Uses Bun's native SQLite driver with WAL mode, foreign keys,
 * and periodic WAL checkpointing.
 */

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { DatabaseProvider } from '../provider.js';
import * as sqliteSchema from '../schema.sqlite.js';

export interface CreateSqliteOptions {
  /** Absolute path to the .db file */
  path: string;
  /** Optional logger */
  log?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

const noop = { info: () => {}, warn: () => {} };

/**
 * Create a SQLite DatabaseProvider with WAL mode, foreign keys, and periodic checkpointing.
 */
export function createSqliteProvider(options: CreateSqliteOptions): DatabaseProvider {
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

  const db = drizzle(sqliteDb, { schema: sqliteSchema }) as BunSQLiteDatabase<typeof sqliteSchema>;

  return {
    db,
    schema: sqliteSchema,
    dialect: 'sqlite',
    rawDriver: sqliteDb,
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
