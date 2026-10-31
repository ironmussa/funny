/**
 * Persistence of each thread's sandbox (change thread-sandboxes).
 */

import { eq } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes } from '../../db/schema.js';

export type ThreadSandboxRow = typeof threadSandboxes.$inferSelect;
export type ThreadSandboxState =
  | 'provisioning'
  | 'installing'
  | 'connecting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'lost';

export interface ThreadSandboxStore {
  get(threadId: string): ResultAsync<ThreadSandboxRow | null, string>;
  /** Insert or replace the thread's row (a re-provision starts a new generation). */
  put(row: ThreadSandboxRow): ResultAsync<void, string>;
  update(
    threadId: string,
    patch: Partial<Omit<ThreadSandboxRow, 'threadId'>>,
  ): ResultAsync<void, string>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const sqlThreadSandboxStore: ThreadSandboxStore = {
  get: (threadId) =>
    ResultAsync.fromPromise(
      db.select().from(threadSandboxes).where(eq(threadSandboxes.threadId, threadId)),
      message,
    ).map(([row]) => row ?? null),

  put: (row) =>
    ResultAsync.fromPromise(
      (async () => {
        await db.delete(threadSandboxes).where(eq(threadSandboxes.threadId, row.threadId));
        await db.insert(threadSandboxes).values(row);
      })(),
      message,
    ),

  update: (threadId, patch) =>
    ResultAsync.fromPromise(
      db
        .update(threadSandboxes)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(eq(threadSandboxes.threadId, threadId)),
      message,
    ).map(() => undefined),
};
