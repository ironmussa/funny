/**
 * Central server database connection (PostgreSQL only).
 *
 * Requires DATABASE_URL environment variable.
 * Call `initDatabase()` at startup before using `db`.
 */

import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';

import { log } from '../lib/logger.js';
import * as schema from './schema.js';

export type AppDatabase = BunSQLDatabase<typeof schema>;

let _db: AppDatabase | null = null;
let _pgClient: SQL | null = null;

/**
 * Initialize the PostgreSQL connection.
 * Must be called once at startup before any DB access.
 */
export async function initDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('DATABASE_URL is required for the central server.', { namespace: 'db' });
    process.exit(1);
  }

  _pgClient = new SQL(databaseUrl);
  _db = drizzle({ client: _pgClient, schema });

  log.info('Connected to PostgreSQL', { namespace: 'db' });
}

/** The Drizzle database instance. `initDatabase()` must be called first. */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    if (!_db) {
      throw new Error('Database not initialized. Call initDatabase() at startup.');
    }
    return (_db as any)[prop];
  },
});

export { schema };

/** The raw SQL client for use with adapters that need it (e.g. Better Auth). */
export function getRawClient(): SQL | null {
  return _pgClient;
}

export async function closeDatabase(): Promise<void> {
  if (_pgClient) {
    try {
      await _pgClient.close();
      log.info('PostgreSQL connection closed', { namespace: 'db' });
    } catch (err) {
      log.warn('Error closing PostgreSQL connection', { namespace: 'db', error: err });
    }
  }
}
