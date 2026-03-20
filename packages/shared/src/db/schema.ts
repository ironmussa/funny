/**
 * Unified schema resolver.
 *
 * Returns the correct Drizzle schema module based on the active dialect.
 */

import type { DbDialect } from './provider.js';

/**
 * Get the Drizzle schema module for the given dialect.
 */
export function getSchema(dialect: DbDialect) {
  if (dialect === 'pg') return require('./schema.pg.js');
  return require('./schema.sqlite.js');
}

// Re-export type-level symbols from the SQLite schema.
// These are structurally identical across dialects so consumers can use
// them for $inferInsert / $inferSelect regardless of the active dialect.
export type * from './schema.sqlite.js';
