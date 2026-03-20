/**
 * PostgreSQL schema — stub.
 *
 * This file will contain pgTable() equivalents of every table in schema.sqlite.ts.
 * For now it re-exports the type-level definitions from the SQLite schema so that
 * type-only imports (e.g. $inferInsert, $inferSelect) resolve correctly.
 *
 * TODO: Implement full pgTable() definitions mirroring schema.sqlite.ts.
 */

// Re-export all type-level symbols so downstream code that does
// `import type { ... } from '@funny/shared/db/schema-pg'` keeps working.
export type * from './schema.sqlite.js';
