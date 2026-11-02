/**
 * Persistence of each thread's sandbox (change thread-sandboxes).
 *
 * State changes go through `transition`, which applies an event of the shared
 * sandbox machine (`@funny/shared/sandbox-machine`) as one conditional UPDATE:
 * the row only moves if its current state accepts the event. Concurrent
 * operations (a stop racing a delete, two wakes…) therefore cannot clobber
 * each other or make an illegal move. `update` never touches the state.
 */

import {
  sandboxTransitionsFor,
  type SandboxEventType,
  type SandboxState,
} from '@funny/shared/sandbox-machine';
import { and, eq, inArray } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes } from '../../db/schema.js';

export type ThreadSandboxRow = typeof threadSandboxes.$inferSelect;
export type ThreadSandboxState = SandboxState;

/** Columns besides the state and the key, which only `transition` / `put` set. */
export type ThreadSandboxPatch = Partial<Omit<ThreadSandboxRow, 'threadId' | 'state'>>;

export type TransitionOutcome =
  | { applied: true; state: ThreadSandboxState }
  /** The row was missing or in a state that does not accept the event. */
  | { applied: false; current: ThreadSandboxState | null };

export interface ThreadSandboxStore {
  get(threadId: string): ResultAsync<ThreadSandboxRow | null, string>;
  /** Insert or replace the thread's row (a re-provision starts a new generation). */
  put(row: ThreadSandboxRow): ResultAsync<void, string>;
  /** Apply a machine event, with the patch, only if the current state accepts it. */
  transition(
    threadId: string,
    event: SandboxEventType,
    patch?: ThreadSandboxPatch,
  ): ResultAsync<TransitionOutcome, string>;
  /** Non-state columns (error, runner id, …). */
  update(threadId: string, patch: ThreadSandboxPatch): ResultAsync<void, string>;
  remove(threadId: string): ResultAsync<void, string>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const get = (threadId: string) =>
  ResultAsync.fromPromise(
    db.select().from(threadSandboxes).where(eq(threadSandboxes.threadId, threadId)),
    message,
  ).map(([row]) => row ?? null);

export const sqlThreadSandboxStore: ThreadSandboxStore = {
  get,

  put: (row) =>
    ResultAsync.fromPromise(
      (async () => {
        await db.delete(threadSandboxes).where(eq(threadSandboxes.threadId, row.threadId));
        await db.insert(threadSandboxes).values(row);
      })(),
      message,
    ),

  transition: (threadId, event, patch = {}) => {
    const rule = sandboxTransitionsFor(event);
    if (!rule) return errAsync(`unknown sandbox event ${event}`);
    return ResultAsync.fromPromise(
      db
        .update(threadSandboxes)
        .set({ ...patch, state: rule.to, updatedAt: new Date().toISOString() })
        .where(
          and(eq(threadSandboxes.threadId, threadId), inArray(threadSandboxes.state, rule.from)),
        )
        .returning({ threadId: threadSandboxes.threadId }),
      message,
    ).andThen((rows) =>
      rows.length > 0
        ? okAsync<TransitionOutcome, string>({ applied: true, state: rule.to })
        : get(threadId).map((row): TransitionOutcome => ({
            applied: false,
            current: (row?.state as ThreadSandboxState | undefined) ?? null,
          })),
    );
  },

  update: (threadId, patch) =>
    ResultAsync.fromPromise(
      db
        .update(threadSandboxes)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(eq(threadSandboxes.threadId, threadId)),
      message,
    ).map(() => undefined),

  remove: (threadId) =>
    ResultAsync.fromPromise(
      db.delete(threadSandboxes).where(eq(threadSandboxes.threadId, threadId)),
      message,
    ).map(() => undefined),
};
