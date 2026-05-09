/**
 * Thread state machine bridge — manages xstate actors per thread.
 * Extracted from thread-store.ts for testability and separation of concerns.
 */

import type { ThreadStatus } from '@funny/shared';
import {
  threadMachine,
  wsEventToMachineEvent,
  type ThreadContext,
} from '@funny/shared/thread-machine';
import { createActor, waitFor } from 'xstate';

import { threadDataMachine, type ThreadDataSnapshot } from '@/machines/thread-data-machine';

export { wsEventToMachineEvent };
export type { ThreadDataSnapshot };

// ── Actor registry ──────────────────────────────────────────────

const threadActors = new Map<string, ReturnType<typeof createActor<typeof threadMachine>>>();

export function getThreadActor(
  threadId: string,
  initialStatus: ThreadStatus = 'pending',
  cost: number = 0,
) {
  let actor = threadActors.get(threadId);
  if (!actor) {
    actor = createActor(threadMachine, {
      input: { threadId, cost, resumeReason: null } as ThreadContext,
    });
    actor.start();
    if (initialStatus !== 'pending') {
      actor.send({ type: 'SET_STATUS', status: initialStatus });
    }
    threadActors.set(threadId, actor);
  }
  return actor;
}

export function transitionThreadStatus(
  threadId: string,
  event: ReturnType<typeof wsEventToMachineEvent>,
  currentStatus: ThreadStatus,
  cost: number = 0,
): ThreadStatus {
  if (!event) return currentStatus;
  const actor = getThreadActor(threadId, currentStatus, cost);
  actor.send(event);
  return actor.getSnapshot().value as ThreadStatus;
}

/**
 * Clean up the actor for a thread (stop + remove from registry).
 * Call when archiving or deleting a thread.
 */
export function cleanupThreadActor(threadId: string): void {
  const actor = threadActors.get(threadId);
  if (actor) {
    actor.stop();
    threadActors.delete(threadId);
  }
  const dataActor = dataActors.get(threadId);
  if (dataActor) {
    dataActor.stop();
    dataActors.delete(threadId);
  }
}

// ── Data actor registry ─────────────────────────────────────────
//
// Per-thread data actors own the fetch lifecycle (unloaded → fetching →
// loaded → stale). The actor's context is the cache — there is no parallel
// store. INVALIDATE transitions back to `unloaded`, structurally guaranteeing
// no stale data can be read after invalidation.

const DATA_ACTOR_LIMIT = 8;
const dataActors = new Map<string, ReturnType<typeof createActor<typeof threadDataMachine>>>();

function getDataActor(threadId: string) {
  let actor = dataActors.get(threadId);
  if (!actor) {
    if (dataActors.size >= DATA_ACTOR_LIMIT) {
      const oldestId = dataActors.keys().next().value;
      if (oldestId) {
        const oldest = dataActors.get(oldestId);
        oldest?.stop();
        dataActors.delete(oldestId);
      }
    }
    actor = createActor(threadDataMachine, { input: { threadId } });
    actor.start();
    dataActors.set(threadId, actor);
  }
  return actor;
}

/** Kick off a background prefetch (no-op if already fetching/loaded). */
export function prefetchThreadData(threadId: string): void {
  getDataActor(threadId).send({ type: 'PREFETCH' });
}

/** Mark a thread's cached data as stale; next load will refetch. */
export function invalidateThreadData(threadId: string): void {
  const actor = dataActors.get(threadId);
  actor?.send({ type: 'INVALIDATE' });
}

/** Returns true when the actor already has fresh data or a fetch is in flight. */
export function isThreadDataPrefetched(threadId: string): boolean {
  const actor = dataActors.get(threadId);
  if (!actor) return false;
  const snap = actor.getSnapshot();
  return snap.matches('loaded') || snap.matches('fetching');
}

/** Returns true only when the actor has fully loaded data (no in-flight fetch). */
export function isThreadDataLoaded(threadId: string): boolean {
  const actor = dataActors.get(threadId);
  if (!actor) return false;
  return actor.getSnapshot().matches('loaded');
}

/** Resolve once the actor finishes loading (reuses any in-flight fetch). */
export async function loadThreadData(threadId: string): Promise<ThreadDataSnapshot> {
  const actor = getDataActor(threadId);
  actor.send({ type: 'LOAD' });
  const finalSnap = await waitFor(
    actor,
    (snap) => snap.matches('loaded') || snap.matches('failed'),
    { timeout: Infinity },
  );
  if (finalSnap.matches('failed')) {
    throw new Error(finalSnap.context.error ?? 'failed to load thread data');
  }
  if (!finalSnap.context.data) {
    throw new Error('thread data actor reached loaded state without data');
  }
  return finalSnap.context.data;
}
