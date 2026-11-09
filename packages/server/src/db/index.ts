/**
 * Central server database connection — dialect-agnostic.
 *
 * Resolves the database dialect at startup:
 *   - `DATABASE_URL` env var present → PostgreSQL
 *   - Otherwise → SQLite at ~/.funny/data.db
 *
 * Exports `db` and `schema` as lazy Proxies so the 22+ consumer files
 * that import from this module require zero changes.
 *
 * Hosts (docs/plans/cloudflare-portability.md, Phase 1):
 *   - `initDatabase()` builds the process-wide provider from the environment
 *     (the Bun host).
 *   - `useDatabaseProvider(provider)` installs a provider the host built itself.
 *   - `runWithDatabase(provider, work)` scopes a provider to one async context,
 *     for hosts that open a connection per request. `db` reads it first.
 */

import { existsSync, writeFileSync, chmodSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
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

/**
 * The active database dialect for this server instance. A live binding:
 * `useDatabaseProvider` sets it from the installed provider, so a host that
 * builds its own provider does not depend on `DATABASE_URL` at import time.
 */
export let dbDialect: DbDialect = process.env.DATABASE_URL ? 'pg' : 'sqlite';

let _provider: DatabaseProvider | null = null;
const transactionContext = new AsyncLocalStorage<any>();
/** Per-async-context provider (one connection per request), read before `_provider`. */
const requestDatabase = new AsyncLocalStorage<DatabaseProvider>();

function activeProvider(): DatabaseProvider {
  const provider = requestDatabase.getStore() ?? _provider;
  if (!provider) {
    throw new Error('Database not initialized. Call initDatabase() at startup.');
  }
  return provider;
}

/** Install the process-wide provider (and its dialect). */
export function useDatabaseProvider(provider: DatabaseProvider): void {
  _provider = provider;
  dbDialect = provider.dialect;
}

/**
 * Run `work` with `provider` as the database for this async context, e.g. a
 * connection opened for one request. Transactions started inside use it too.
 * Its dialect must match the instance dialect: SQL branches read `dbDialect`.
 */
export function runWithDatabase<T>(provider: DatabaseProvider, work: () => T): T {
  if (provider.dialect !== dbDialect) {
    throw new Error(
      `runWithDatabase: provider dialect "${provider.dialect}" does not match the instance dialect "${dbDialect}"`,
    );
  }
  return requestDatabase.run(provider, work);
}

// Legacy compat — kept so `setConnection()` callers
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
    useDatabaseProvider(
      createDatabase({
        dialect: 'pg',
        connectionString: process.env.DATABASE_URL!,
        log,
      }),
    );
  } else {
    const dbPath = options?.sqlitePath ?? resolve(DATA_DIR, 'data.db');
    // SQLite's in-memory sentinel — never touch the filesystem.
    if (dbPath !== ':memory:') {
      // Ensure restrictive permissions on the database file (owner-only read/write)
      if (!existsSync(dbPath)) {
        writeFileSync(dbPath, '', { mode: 0o600 });
      } else {
        try {
          chmodSync(dbPath, 0o600);
        } catch {
          // May fail on non-POSIX filesystems — best effort
        }
      }
    }
    // Use the legacy wrapper so _legacyConnection stays populated
    const connection = createSqliteDatabase({ mode: 'sqlite', path: dbPath, log });
    _legacyConnection = connection;
    useDatabaseProvider({
      db: connection.db,
      schema: connection.schema,
      dialect: 'sqlite',
      rawDriver: connection.sqlite,
      close: () => connection.close(),
    });
  }
  return okAsync(undefined);
}

// ── Lazy Proxies ─────────────────────────────────────────────────

/** The Drizzle database instance. `initDatabase()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    return (transactionContext.getStore() ?? (activeProvider().db as any))[prop];
  },
});

/**
 * Run async database work in one transaction when the active driver supports it.
 * Bun SQLite transactions are synchronous, so callers receive a non-transactional
 * execution there rather than a transaction that commits before awaited work ends.
 */
export async function withDatabaseTransaction<T>(work: () => Promise<T>): Promise<T> {
  const provider = activeProvider();
  if (provider.dialect === 'sqlite') return work();
  return provider.db.transaction((tx: any) => transactionContext.run(tx, work));
}

export { schema };

// ── Provider access ──────────────────────────────────────────────

/** Set a pre-existing connection (e.g. shared from runtime). */
export function setConnection(conn: DatabaseConnection): void {
  _legacyConnection = conn;
  useDatabaseProvider({
    db: conn.db,
    schema: conn.schema,
    dialect: 'sqlite',
    rawDriver: conn.sqlite,
    close: () => conn.close(),
  });
}

export async function closeDatabase(): Promise<void> {
  if (_provider) {
    await _provider.close();
  }
}

/** Test-only: drop singleton refs after closing an in-memory DB. */
export function resetDatabaseForTests(): void {
  _provider = null;
  _legacyConnection = null;
  dbDialect = process.env.DATABASE_URL ? 'pg' : 'sqlite';
}

// ── Compat helpers ───────────────────────────────────────────────

export const dbAll = _dbAll;
export const dbGet = _dbGet;
export const dbRun = _dbRun;
