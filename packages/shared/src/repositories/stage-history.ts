/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic stage history repository. Accepts db + schema via dependency injection.
 */

import { nanoid } from 'nanoid';

import type { AppDatabase, dbRun as dbRunFn } from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface StageHistoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbRun: typeof dbRunFn;
}

export function createStageHistoryRepository(deps: StageHistoryDeps) {
  const { db, schema, dbRun } = deps;

  /** Record a stage transition in the history table */
  async function recordStageChange(threadId: string, fromStage: string | null, toStage: string) {
    const id = nanoid();
    await dbRun(
      db.insert(schema.stageHistory).values({
        id,
        threadId,
        fromStage,
        toStage,
        changedAt: new Date().toISOString(),
      }),
    );
  }

  return {
    recordStageChange,
  };
}
