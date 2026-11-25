/**
 * Shared migration infrastructure — dialect-agnostic.
 *
 * Provides helpers and a migration runner.
 * Each package defines its own migrations array and calls `runMigrations()`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { sql } from 'drizzle-orm';

import type { DbDialect } from './provider.js';

// ── Types ────────────────────────────────────────────────────────

export interface Migration {
  name: string;
  up: () => Promise<void>;
}

export interface MigrationContext {
  /** Execute a SQL statement (CREATE, ALTER, INSERT, etc.) */
  exec: (query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>) => Promise<void>;
  /** Query a single row */
  queryOne: <T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ) => Promise<T | undefined>;
  /** Safely add a column (idempotent) */
  addColumn: (table: string, column: string, type: string, dflt?: string) => Promise<void>;
  /** Drop a column if it exists (idempotent). Destroys its data. */
  dropColumn: (table: string, column: string) => Promise<void>;
  /** The active dialect — migrations can use this to emit dialect-specific SQL. */
  dialect: DbDialect;
}

export interface MigrationLogger {
  info: (msg: string, meta?: any) => void;
  error: (msg: string, meta?: any) => void;
}

// ── Transaction scope ────────────────────────────────────────────

/**
 * The PostgreSQL transaction the running migration belongs to. Migrations
 * build their context from the module-level `db` (a pool), so `runMigrations`
 * cannot hand them a transaction handle: it sets the transaction here instead,
 * and a context for that same `db` sends its statements through it.
 */
const pgMigrationTx = new AsyncLocalStorage<{ db: unknown; tx: any }>();

/**
 * Advisory lock key held by the transaction that applies a migration, so two
 * instances starting together cannot run the same migration (PostgreSQL).
 */
const MIGRATION_LOCK_KEY = 'funny:_migrations';

// ── Context factory ──────────────────────────────────────────────

/**
 * Create a migration context from a Drizzle database instance.
 *
 * @param db    Drizzle database instance (SQLite or PostgreSQL)
 * @param dialect  The active database dialect (defaults to 'sqlite' for backward compat)
 */
export function createMigrationContext(db: any, dialect: DbDialect = 'sqlite'): MigrationContext {
  if (dialect === 'pg') {
    return createPgMigrationContext(db);
  }
  return createSqliteMigrationContext(db);
}

function createSqliteMigrationContext(db: any): MigrationContext {
  function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
    db.run(query);
    return Promise.resolve();
  }

  function queryOne<T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ): Promise<T | undefined> {
    return Promise.resolve<T | undefined>(db.get(query));
  }

  async function addColumn(table: string, column: string, type: string, dflt?: string) {
    try {
      const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
      await exec(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`));
    } catch (err) {
      // SQLite has no `ADD COLUMN IF NOT EXISTS`, so a re-run hits "duplicate
      // column name" — that's the only error we may safely ignore. Anything
      // else (locked db, bad type, missing table) is a real failure: re-raise
      // it so the migration is NOT recorded as applied and gets retried next
      // boot. Swallowing everything here once left a migration marked complete
      // with a column it never managed to add.
      //
      // The driver wraps the SQLite error in a DrizzleError whose own message
      // is just "Failed to run the query '…'", so we must walk the `cause`
      // chain to find the real "duplicate column name" text.
      let text = '';
      let e: unknown = err;
      while (e != null) {
        // SAFETY: both fields are read optionally: a thrown non-Error (or one
        // without a cause) reads undefined, and `?? e` falls back to the value.
        const link = e as { cause?: unknown; message?: string };
        text += ` ${String(link.message ?? e)}`;
        if (link.cause === e) break;
        e = link.cause;
      }
      if (!/duplicate column name/i.test(text)) throw err;
    }
  }

  async function dropColumn(table: string, column: string) {
    // SQLite (3.35+) has DROP COLUMN but no `IF EXISTS` — check first.
    const columns: { name: string }[] = db.all(sql.raw(`PRAGMA table_info(${table})`));
    if (!columns.some((c) => c.name === column)) return;
    await exec(sql.raw(`ALTER TABLE ${table} DROP COLUMN ${column}`));
  }

  return { exec, queryOne, addColumn, dropColumn, dialect: 'sqlite' };
}

function createPgMigrationContext(db: any): MigrationContext {
  /** The migration's transaction when `runMigrations` is applying one on this `db`. */
  function currentTx(): any {
    const scope = pgMigrationTx.getStore();
    return scope && scope.db === db ? scope.tx : undefined;
  }

  async function exec(query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>): Promise<void> {
    const tx = currentTx();
    if (!tx) {
      await db.execute(query);
      return;
    }
    // A failed statement aborts a PostgreSQL transaction. Run each one in a
    // savepoint (a nested drizzle transaction) so a migration that catches an
    // expected failure (a rename already done, a column already dropped) can
    // go on, as it could before migrations ran in a transaction.
    await tx.transaction((savepoint: any) => savepoint.execute(query));
  }

  async function queryOne<T>(
    query: ReturnType<typeof sql> | ReturnType<typeof sql.raw>,
  ): Promise<T | undefined> {
    const result = await (currentTx() ?? db).execute(query);
    // db.execute() returns pg QueryResult — rows are in .rows
    const rows = result?.rows ?? result;
    const first: T | undefined = rows?.[0];
    return first;
  }

  async function addColumn(table: string, column: string, type: string, dflt?: string) {
    // PostgreSQL supports IF NOT EXISTS natively
    const defaultClause = dflt !== undefined ? ` DEFAULT ${dflt}` : '';
    await exec(
      sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}${defaultClause}`),
    );
  }

  async function dropColumn(table: string, column: string) {
    await exec(sql.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`));
  }

  return { exec, queryOne, addColumn, dropColumn, dialect: 'pg' };
}

// ── Migration runner ─────────────────────────────────────────────

/**
 * Run a list of migrations against the database.
 *
 * Creates the `_migrations` tracking table if needed, then applies
 * each migration that hasn't been run yet (in order).
 *
 * @param db          Drizzle database instance
 * @param migrations  Ordered list of migrations to apply
 * @param log         Logger for info/error messages
 * @param label       Log namespace label
 * @param dialect     Database dialect (defaults to 'sqlite' for backward compat)
 */
export async function runMigrations(
  db: any,
  migrations: Migration[],
  log: MigrationLogger,
  label: string = 'db',
  dialect: DbDialect = 'sqlite',
): Promise<void> {
  const ctx = createMigrationContext(db, dialect);

  // Ensure migration tracking table exists. Under the lock: two PostgreSQL
  // sessions running CREATE TABLE IF NOT EXISTS at once can still collide.
  await inMigrationTransaction(db, dialect, () =>
    ctx.exec(sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `),
  );

  // One query for every applied migration instead of one per migration: on
  // PostgreSQL each was a network round trip before the server could serve.
  const done = await appliedMigrationNames(db, dialect);
  let applied = 0;

  for (const migration of migrations) {
    if (done.has(migration.name)) continue;

    try {
      // Each migration and its `_migrations` row commit together, so a crash
      // midway leaves nothing half applied. The transaction holds the
      // migration lock, and re-checks the row under it: another instance may
      // have applied this migration while we waited.
      const ran = await inMigrationTransaction(db, dialect, async () => {
        const row = await ctx.queryOne<{ name: string }>(
          sql`SELECT name FROM _migrations WHERE name = ${migration.name}`,
        );
        if (row) return false;
        await migration.up();
        await ctx.exec(
          sql`INSERT INTO _migrations (name, applied_at) VALUES (${migration.name}, ${new Date().toISOString()})`,
        );
        return true;
      });
      if (ran) applied++;
    } catch (err) {
      log.error(`Migration ${migration.name} failed`, { namespace: label, error: err });
      throw err;
    }
  }

  if (applied > 0) {
    log.info(`Applied ${applied} migration(s)`, { namespace: label });
  }
  log.info('Tables ready', { namespace: label });
}

/**
 * Run `work` in one transaction that holds the migration lock, committing when
 * it resolves and rolling back when it throws.
 *
 * - PostgreSQL: a drizzle transaction that takes a transaction-level advisory
 *   lock (released at commit or rollback). The migration's context finds the
 *   transaction through `pgMigrationTx`.
 * - SQLite: `BEGIN IMMEDIATE` takes the database write lock up front, so a
 *   second process waits (busy_timeout) instead of running the same migration.
 *   The connection is the process's only one, so its statements are in the
 *   transaction without routing.
 */
async function inMigrationTransaction<T>(
  db: any,
  dialect: DbDialect,
  work: () => Promise<T>,
): Promise<T> {
  if (dialect === 'pg') {
    return db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))`);
      return pgMigrationTx.run({ db, tx }, work);
    });
  }

  db.run(sql`BEGIN IMMEDIATE`);
  let result: T;
  try {
    result = await work();
  } catch (err) {
    // SQLite may already have rolled the transaction back on its own (disk
    // full, I/O error); report the migration's error, not "no transaction".
    if (db.$client?.inTransaction !== false) db.run(sql`ROLLBACK`);
    throw err;
  }
  db.run(sql`COMMIT`);
  return result;
}

async function appliedMigrationNames(db: any, dialect: DbDialect): Promise<Set<string>> {
  const query = sql`SELECT name FROM _migrations`;
  const rows: { name: string }[] =
    dialect === 'pg'
      ? await db.execute(query).then((result: any) => result?.rows ?? result ?? [])
      : db.all(query);
  return new Set(rows.map((row) => row.name));
}

// Re-export sql for use in migration definitions
export { sql };

/** Preserve current session ownership before future provider/model switches. */
export async function migrateThreadSessions(exec: MigrationContext['exec']): Promise<void> {
  await exec(sql`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, session_id)
    )
  `);
  await exec(sql`
    CREATE INDEX IF NOT EXISTS idx_thread_sessions_session ON thread_sessions (session_id)
  `);
  await exec(sql`
    INSERT INTO thread_sessions (thread_id, session_id)
    SELECT id, session_id FROM threads WHERE session_id IS NOT NULL AND session_id <> ''
    ON CONFLICT DO NOTHING
  `);
}
