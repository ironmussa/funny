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
import { createActor } from 'xstate';

import { loadThreadScrollPosition } from '@/lib/thread-scroll-position';
import { threadDataMachine, type ThreadDataSnapshot } from '@/machines/thread-data-machine';

export { wsEventToMachineEvent };
export type { ThreadDataSnapshot };

// ── Actor registry ──────────────────────────────────────────────

const THREAD_ACTOR_LIMIT = 64;
const threadActors = new Map<string, ReturnType<typeof createActor<typeof threadMachine>>>();

function evictOldestThreadActorIfNeeded(): void {
  if (threadActors.size < THREAD_ACTOR_LIMIT) return;
  const oldestId = threadActors.keys().next().value;
  if (!oldestId) return;
  const oldest = threadActors.get(oldestId);
  oldest?.stop();
  threadActors.delete(oldestId);
}

export function getThreadActor(
  threadId: string,
  initialStatus: ThreadStatus = 'pending',
  cost: number = 0,
) {
  let actor = threadActors.get(threadId);
  if (actor) {
    threadActors.delete(threadId);
    threadActors.set(threadId, actor);
    return actor;
  }

  evictOldestThreadActorIfNeeded();
  actor = createActor(threadMachine, {
    input: { threadId, cost, resumeReason: null } as ThreadContext,
  });
  actor.start();
  if (initialStatus !== 'pending') {
    actor.send({ type: 'SET_STATUS', status: initialStatus });
  }
  threadActors.set(threadId, actor);
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

export function getThreadActorCountForTests(): number {
  return threadActors.size;
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

function loadedDataContainsStoredScrollPosition(snapshot: ThreadDataSnapshot, threadId: string) {
  const position = loadThreadScrollPosition(threadId);
  if (!position) return true;

  const thread = snapshot.thread;
  const messages = thread.messages ?? [];
  if (messages.length === 0) return true;

  if (position.progress >= 0.999) {
    return !(thread.hasMoreAfter ?? false);
  }

  const anchorKey = position.anchor?.key;
  if (anchorKey) {
    const hasAnchor = messages.some(
      (message) =>
        message.id === anchorKey ||
        message.toolCalls?.some((toolCall) => toolCall.id === anchorKey),
    );
    if (hasAnchor) return true;
  }

  const total = thread.total ?? messages.length;
  const windowStart = thread.windowStart ?? 0;
  const targetIndex = Math.round(position.progress * Math.max(0, total - 1));
  return targetIndex >= windowStart && targetIndex < windowStart + messages.length;
}

/**
 * Hard cap on how long `loadThreadData` will wait for the actor to reach a
 * terminal state. Without a bound, an actor whose fetch never resolves (or
 * gets stuck mid-flight) would hang the caller forever — and since
 * `selectThread` keys "this thread is currently loading" off the resolution
 * of this promise, the UI would stop responding to clicks on that thread.
 */
const LOAD_THREAD_TIMEOUT_MS = 15_000;

/**
 * Hard cap on retries when the actor cycles through `unloaded` due to
 * repeated `INVALIDATE` events. Each transition to `unloaded` while a caller
 * is waiting triggers a fresh `LOAD`. If invalidates keep pouring in faster
 * than the fetcher can complete, we bail out instead of refetching forever.
 */
const LOAD_THREAD_MAX_REATTEMPTS = 5;

/**
 * Resolve once the actor finishes loading (reuses any in-flight fetch).
 *
 * Resilient to two failure modes that previously hung the caller:
 *  - `INVALIDATE` during `fetching` (a WS event arrived for the thread while
 *    its `selectThread` was awaiting initial load) — the actor transitions
 *    `fetching → unloaded`, the old `invoke` is torn down, and the original
 *    `waitFor(loaded || failed)` never matched. Now we observe the unloaded
 *    state and re-send `LOAD` so the awaiter eventually gets a snapshot.
 *  - Indefinite hangs — bounded by `LOAD_THREAD_TIMEOUT_MS` so the caller
 *    can recover (clears `selectingThreadId`, allows re-clicking the thread).
 */
export function loadThreadData(threadId: string): Promise<ThreadDataSnapshot> {
  const actor = getDataActor(threadId);
  const snapshot = actor.getSnapshot();
  if (
    snapshot.matches('loaded') &&
    snapshot.context.data &&
    !loadedDataContainsStoredScrollPosition(snapshot.context.data, threadId)
  ) {
    actor.send({ type: 'INVALIDATE' });
  }

  return new Promise<ThreadDataSnapshot>((resolve, reject) => {
    let settled = false;
    let reattempts = 0;
    const subscription = actor.subscribe((snap) => {
      if (settled) return;
      if (snap.matches('loaded')) {
        settled = true;
        clearTimeout(timeoutHandle);
        subscription.unsubscribe();
        if (snap.context.data) resolve(snap.context.data);
        else reject(new Error('thread data actor reached loaded state without data'));
        return;
      }
      if (snap.matches('failed')) {
        settled = true;
        clearTimeout(timeoutHandle);
        subscription.unsubscribe();
        reject(new Error(snap.context.error ?? 'failed to load thread data'));
        return;
      }
      if (snap.matches('unloaded')) {
        // Either we just started observing and need to kick off the fetch,
        // or an INVALIDATE just transitioned us back here mid-flight.
        if (reattempts >= LOAD_THREAD_MAX_REATTEMPTS) {
          settled = true;
          clearTimeout(timeoutHandle);
          subscription.unsubscribe();
          reject(
            new Error(
              `thread data actor for ${threadId} kept invalidating during fetch (${reattempts} retries)`,
            ),
          );
          return;
        }
        reattempts += 1;
        actor.send({ type: 'LOAD' });
      }
      // `fetching` is a transient state — wait for the next snapshot.
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      reject(
        new Error(`thread data actor for ${threadId} timed out after ${LOAD_THREAD_TIMEOUT_MS}ms`),
      );
    }, LOAD_THREAD_TIMEOUT_MS);

    // Kick off the load. The subscribe callback above also fires on the
    // initial snapshot, so if the actor is already in `loaded` / `failed`,
    // resolution happens synchronously without ever hitting `unloaded`.
    actor.send({ type: 'LOAD' });
  });
}
