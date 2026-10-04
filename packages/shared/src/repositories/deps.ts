/**
 * What every repository factory is built from: a Drizzle database, the
 * (SQLite-typed) schema, and the dialect-agnostic query helpers. Each
 * repository declares the subset it uses with `Pick<RepoDeps, …>`.
 */

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface RepoDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}
