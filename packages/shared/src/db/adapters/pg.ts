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
 * Create a PostgreSQL DatabaseProvider backed by a pg Pool.
 */
export function createPgProvider(options: CreatePgOptions): DatabaseProvider {
  const { Pool } = require('pg') as typeof import('pg');
  const { drizzle } =
    require('drizzle-orm/node-postgres') as typeof import('drizzle-orm/node-postgres');
  const pgSchema = require('../schema.pg.js');

  const logger = options.log ?? noop;

  const pool = new Pool({
    connectionString: options.connectionString,
    max: 10,
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
