/**
 * PostgreSQL database adapter — stub.
 *
 * This file defines the entry point for PostgreSQL support.
 * The actual implementation will be added in a future iteration.
 */

import type { DatabaseProvider } from '../provider.js';

export interface CreatePgOptions {
  /** PostgreSQL connection string (e.g. postgres://user:pass@host:5432/db) */
  connectionString: string;
  /** Optional logger */
  log?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

/**
 * Create a PostgreSQL DatabaseProvider.
 *
 * @throws Always — PostgreSQL support is not yet implemented.
 */
export function createPgProvider(_options: CreatePgOptions): DatabaseProvider {
  throw new Error(
    'PostgreSQL support is not yet implemented. ' +
      'Remove DATABASE_URL from your environment to use SQLite (default).',
  );
}
