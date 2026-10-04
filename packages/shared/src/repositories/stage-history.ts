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

import type { AppDatabase } from '../db/connection.js';
import type { RepoDeps } from './deps.js';

export type StageHistoryDeps = Pick<RepoDeps, 'db' | 'schema' | 'dbRun'>;

export function createStageHistoryRepository(deps: StageHistoryDeps) {
  const { db, schema, dbRun } = deps;

  /** Record a stage transition in the history table. Accepts an optional transaction context. */
  async function recordStageChange(
    threadId: string,
    fromStage: string | null,
    toStage: string,
    tx?: AppDatabase,
  ) {
    const id = nanoid();
    const target = tx ?? db;
    await dbRun(
      target.insert(schema.stageHistory).values({
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
