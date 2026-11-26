/**
 * Unified SQLite schema — all tables for both runtime and server.
 *
 * This is the single source of truth for SQLite column definitions.
 * Both packages/runtime and packages/server import from here. The tables
 * are declared in `./schema-sqlite/` by area and re-exported from this path,
 * so `import * as schema from '@funny/shared/db/schema-sqlite'` still sees
 * every table.
 */

export * from './schema-sqlite/runtime-tables.js';
export * from './schema-sqlite/factory-tables.js';
export * from './schema-sqlite/server-tables.js';
export * from './schema-sqlite/auth-tables.js';
