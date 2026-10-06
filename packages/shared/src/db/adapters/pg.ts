/**
 * PostgreSQL database adapter.
 *
 * Uses the `pg` driver (node-postgres Pool) with Drizzle ORM.
 */

import type { DatabaseProvider } from '../provider.js';

export interface CreatePgOptions {
  /** PostgreSQL connection string (e.g. postgres://user:pass@host:5432/db) */
  connectionString: string;
  /** Optional logger */
  log?: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
}

const noop = { info: () => {}, warn: () => {} };

/**
 * Type parsers for this pool. `pg` returns int8 (bigint, and every COUNT(*))
 * as a string to avoid precision loss above 2^53. funny's int8 values are
 * epoch-millisecond timestamps and counts, far below that, and SQLite returns
 * them as numbers — so parse them as numbers here too, for raw SQL as well as
 * Drizzle's typed selects.
 */
export function pgTypeParsers(types: typeof import('pg').types) {
  return {
    getTypeParser(oid: number, format?: 'text' | 'binary') {
      if (oid === types.builtins.INT8 && format !== 'binary')
        return (value: string) => Number(value);
      return types.getTypeParser(oid, format as any);
    },
  };
}

/**
 * Create a PostgreSQL DatabaseProvider backed by a pg Pool.
 */
export function createPgProvider(options: CreatePgOptions): DatabaseProvider {
  const { Pool, types } = require('pg') as typeof import('pg');
  const { drizzle } =
    require('drizzle-orm/node-postgres') as typeof import('drizzle-orm/node-postgres');
  const pgSchema = require('../schema.pg.js');

  const logger = options.log ?? noop;

  const pool = new Pool({
    connectionString: options.connectionString,
    max: 10,
    types: pgTypeParsers(types),
  });

  pool.on('error', (err: Error) => {
    logger.warn('Unexpected PostgreSQL pool error', { namespace: 'db', error: err });
  });

  const db = drizzle(pool, { schema: pgSchema });

  logger.info('PostgreSQL connection pool created', { namespace: 'db' });

  return {
    db,
    schema: pgSchema,
    dialect: 'pg',
    rawDriver: pool,
    async close() {
      try {
        await pool.end();
        logger.info('PostgreSQL pool closed', { namespace: 'db' });
      } catch (err) {
        logger.warn('Error closing PostgreSQL pool', { namespace: 'db', error: err });
      }
    },
  };
}
