/**
 * Stage history tracking — records thread stage transitions.
 */

import { nanoid } from 'nanoid';

import { db, schema } from '../db/index.js';

/** Record a stage transition in the history table */
export function recordStageChange(threadId: string, fromStage: string | null, toStage: string) {
  const id = nanoid();
  db.insert(schema.stageHistory)
    .values({
      id,
      threadId,
      fromStage,
      toStage,
      changedAt: new Date().toISOString(),
    })
    .run();
}
