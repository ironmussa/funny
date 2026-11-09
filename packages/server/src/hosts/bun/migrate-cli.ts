/**
 * `bun run db:migrate` — apply the central server migrations and exit, without
 * starting the server. The Bun host still auto-migrates at boot; this lets a
 * deployment migrate as a separate step (docs/plans/cloudflare-portability.md,
 * Phase 1). Uses the same database resolution as the server (`DATABASE_URL`,
 * else SQLite under the data dir).
 */

import { log } from '../../lib/logger.js';

/** Returns the process exit code: 0 when migrations applied, 1 otherwise. */
export async function runMigrateCommand(): Promise<number> {
  const { initDatabase, closeDatabase, dbDialect } = await import('../../db/index.js');
  const { autoMigrate } = await import('../../db/migrate.js');

  const init = await initDatabase();
  if (init.isErr()) {
    log.error('Database initialization failed', { namespace: 'db-migrate', error: init.error });
    return 1;
  }
  try {
    await autoMigrate();
    log.info('Migrations applied', { namespace: 'db-migrate', dialect: dbDialect });
    return 0;
  } catch (error) {
    log.error('Migrations failed', {
      namespace: 'db-migrate',
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await closeDatabase();
  }
}

if (import.meta.main) {
  process.exit(await runMigrateCommand());
}
