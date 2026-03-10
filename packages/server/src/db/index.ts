/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 *
 * Database factory — creates SQLite or PostgreSQL connection based on DB_MODE.
 * Exports `db`, `schema`, and `sqlite` (SQLite-only) for backward compatibility.
 *
 * The default SQLite path uses synchronous static imports.
 * PostgreSQL requires calling `initPostgres()` before using `db`.
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'path';

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';
import { getDbMode, getDatabaseUrl } from './db-mode.js';
import * as sqliteSchema from './schema.js';

export type AppDatabase = BunSQLiteDatabase<typeof sqliteSchema>;

const mode = getDbMode();

let _db!: AppDatabase;
let _sqlite: Database | null = null;
let _pgInitialized = false;

// ── Default SQLite path (synchronous) ───────────────────────────
if (mode === 'sqlite') {
  const dbPath = resolve(DATA_DIR, 'data.db');
  const sqliteDb = new Database(dbPath);

  sqliteDb.exec('PRAGMA journal_mode = WAL');
  sqliteDb.exec('PRAGMA foreign_keys = ON');

  const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const walCheckpointTimer = setInterval(() => {
    try {
      sqliteDb.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch (err) {
      log.warn('WAL checkpoint failed', { namespace: 'db', error: err });
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  if (walCheckpointTimer.unref) walCheckpointTimer.unref();

  _sqlite = sqliteDb;
  _db = drizzle(sqliteDb, { schema: sqliteSchema });

  shutdownManager.register(
    'database',
    () => {
      clearInterval(walCheckpointTimer);
      try {
        sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {}
      try {
        sqliteDb.close();
        log.info('Database closed', { namespace: 'db' });
      } catch (err) {
        log.warn('Error closing database', { namespace: 'db', error: err });
      }
    },
    ShutdownPhase.DATABASE,
  );
}

// ── PostgreSQL initialization (async, must be called at startup) ──
export async function initPostgres(): Promise<void> {
  if (mode !== 'postgres' || _pgInitialized) return;

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    log.error(
      'PostgreSQL connection not configured. Provide either DATABASE_URL or DB_HOST + DB_USER.',
      { namespace: 'db' },
    );
    process.exit(1);
  }

  const { SQL } = await import('bun');
  const { drizzle: drizzlePg } = await import('drizzle-orm/bun-sql');
  const pgSchema = await import('./schema.pg.js');

  const pgClient = new SQL(databaseUrl);
  _db = drizzlePg({ client: pgClient, schema: pgSchema }) as unknown as AppDatabase;

  shutdownManager.register(
    'database',
    async () => {
      try {
        await pgClient.close();
        log.info('PostgreSQL connection closed', { namespace: 'db' });
      } catch (err) {
        log.warn('Error closing PostgreSQL connection', { namespace: 'db', error: err });
      }
    },
    ShutdownPhase.DATABASE,
  );

  _pgInitialized = true;
  log.info('Connected to PostgreSQL', { namespace: 'db' });
}

// ── Exports ─────────────────────────────────────────────────────

/** The Drizzle database instance. In Postgres mode, `initPostgres()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (mode === 'postgres' && !_pgInitialized) {
      throw new Error('PostgreSQL not initialized. Call initPostgres() at startup.');
    }
    return (_db as any)[prop];
  },
});

export const schema = sqliteSchema;
export const sqlite = _sqlite;
export const dbMode = mode;

// ── Compat helpers (work with both SQLite sync & PostgreSQL async) ──

/** Execute a SELECT query and return all rows. Works with both SQLite (.all()) and PG (await). */
export async function dbAll<T = any>(query: any): Promise<T[]> {
  if (typeof query.all === 'function') return query.all();
  return query;
}

/** Execute a SELECT query and return the first row. Works with both SQLite (.get()) and PG (await). */
export async function dbGet<T = any>(query: any): Promise<T | undefined> {
  if (typeof query.get === 'function') return query.get();
  const rows = await query;
  return rows[0];
}

/** Execute a mutation query (INSERT/UPDATE/DELETE). Works with both SQLite (.run()) and PG (await). */
export async function dbRun(query: any): Promise<void> {
  if (typeof query.run === 'function') {
    query.run();
    return;
  }
  await query;
}

/** @deprecated Use shutdown manager instead. Only works in SQLite mode. */
export function closeDatabase() {
  if (_sqlite) {
    try {
      _sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    try {
      _sqlite.close();
      log.info('Database closed', { namespace: 'db' });
    } catch (err) {
      log.warn('Error closing database', { namespace: 'db', error: err });
    }
  }
}
