/**
 * The server's Drizzle schema: the SQLite definitions from
 * `@funny/shared/db/schema-sqlite` (the Postgres twin is kept identical by
 * `__tests__/db/schema-drift.test.ts`).
 *
 * Re-exported wholesale so this module satisfies `DatabaseConnection.schema`
 * and repository factories accept it without casts.
 */
export * from '@funny/shared/db/schema-sqlite';
