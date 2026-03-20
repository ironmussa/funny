/**
 * Unified schema resolver.
 *
 * Returns the correct Drizzle schema module based on the active dialect.
 * For now both dialects resolve to the SQLite schema (PG is a stub).
 */

import type { DbDialect } from './provider.js';

/**
 * Get the Drizzle schema module for the given dialect.
 *
 * Once the PostgreSQL schema is implemented this will dynamically resolve
 * to `schema.pg.ts` when `dialect === 'pg'`.
 */
export function getSchema(dialect: DbDialect) {
  // TODO: when schema.pg.ts has real pgTable() definitions, resolve it here:
  // if (dialect === 'pg') return require('./schema.pg.js');
  void dialect;
  return require('./schema.sqlite.js');
}

// Re-export type-level symbols from the SQLite schema.
// These are structurally identical across dialects so consumers can use
// them for $inferInsert / $inferSelect regardless of the active dialect.
export type * from './schema.sqlite.js';
