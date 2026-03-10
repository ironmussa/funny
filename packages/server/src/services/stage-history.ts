/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { nanoid } from 'nanoid';

import { db, schema, dbRun } from '../db/index.js';

/** Record a stage transition in the history table */
export async function recordStageChange(
  threadId: string,
  fromStage: string | null,
  toStage: string,
) {
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
