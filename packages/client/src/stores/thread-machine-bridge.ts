import type { ThreadStatus } from '@funny/shared';
/**
 * Thread state machine bridge — status transitions (pure, from the stored
 * status) and the per-thread data-loading actors.
 * Extracted from thread-store.ts for testability and separation of concerns.
 */
import { waitFor } from '@funny/shared/async';
import { resolveThreadTransition, wsEventToMachineEvent } from '@funny/shared/thread-machine';
import { createActor } from 'xstate';

import { createClientLogger } from '@/lib/client-logger';
import { loadThreadScrollPosition } from '@/lib/thread-scroll-position';
import { threadDataMachine, type ThreadDataSnapshot } from '@/machines/thread-data-machine';

const log = createClientLogger('thread-machine');

export { wsEventToMachineEvent };
export type { ThreadDataSnapshot };

// ── Thread status ───────────────────────────────────────────────

/**
 * The status `event` leads to from `currentStatus` (the status on the thread
 * row or loaded payload being patched). An event `currentStatus` does not
 * accept returns `currentStatus` unchanged.
 *
 * Pure on purpose: the store is the only place a thread's status lives, so a
 * row refreshed from the server (list reload, detail fetch, reconnect resync)
 * is what the next event is judged against.
 */
export function transitionThreadStatus(
  threadId: string,
  event: ReturnType<typeof wsEventToMachineEvent>,
  currentStatus: ThreadStatus,
  cost: number = 0,
): ThreadStatus {
  if (!event) return currentStatus;
  const { status, accepted } = resolveThreadTransition(currentStatus, event, { cost });
  if (!accepted) {
    log.debug('status event not accepted', {
      threadId,
      from: currentStatus,
      event: event.type,
      status: event.type === 'SET_STATUS' ? event.status : '',
    });
  }
  return status;
}

/**
 * Clean up the data actor for a thread (stop + remove from registry).
 * Call when archiving or deleting a thread.
 */
export function cleanupThreadActor(threadId: string): void {
  const dataActor = dataActors.get(threadId);
  if (dataActor) {
    dataActor.stop();
    dataActors.delete(threadId);
  }
}

// ── Data actor registry ─────────────────────────────────────────
//
// Per-thread data actors own the fetch lifecycle (unloaded → fetching →
// loaded). The actor's context is the cache — there is no parallel store.
// INVALIDATE on a loaded actor transitions back to `unloaded`. INVALIDATE
// during `fetching` only marks the coming snapshot `stale`: the fetch keeps
// running, its waiter resolves (and replays the buffered WS events), and the
// next `loadThreadData` refetches instead of serving the stale snapshot.

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
  return (snap.matches('loaded') && !snap.context.stale) || snap.matches('fetching');
}

/** Returns true only when the actor has fresh, fully loaded data (no in-flight fetch). */
export function isThreadDataLoaded(threadId: string): boolean {
  const actor = dataActors.get(threadId);
  if (!actor) return false;
  const snap = actor.getSnapshot();
  return snap.matches('loaded') && !snap.context.stale;
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
 * Safety cap on re-sent `LOAD`s when the actor is seen in `unloaded` while a
 * caller waits. INVALIDATE during `fetching` no longer leaves the state, so
 * this only guards against an unexpected loop.
 */
const LOAD_THREAD_MAX_REATTEMPTS = 5;

/**
 * Resolve once the actor finishes loading (reuses any in-flight fetch).
 *
 *  - `INVALIDATE` during `fetching` (a WS event arrived for the thread while
 *    its `selectThread` was awaiting the load) does not restart the fetch;
 *    the snapshot resolves marked stale and the events are replayed from the
 *    WS buffer. A loaded-but-stale snapshot is refetched here.
 *  - Indefinite hangs — bounded by `LOAD_THREAD_TIMEOUT_MS` so the caller
 *    can recover (clears `selectingThreadId`, allows re-clicking the thread).
 */
export function loadThreadData(threadId: string): Promise<ThreadDataSnapshot> {
  const actor = getDataActor(threadId);
  const snapshot = actor.getSnapshot();
  if (
    snapshot.matches('loaded') &&
    (snapshot.context.stale ||
      (snapshot.context.data &&
        !loadedDataContainsStoredScrollPosition(snapshot.context.data, threadId)))
  ) {
    actor.send({ type: 'INVALIDATE' });
  }

  return waitFor<ThreadDataSnapshot>(
    (resolve, reject) => {
      let settled = false;
      let reattempts = 0;
      const subscription = actor.subscribe((snap) => {
        if (settled) return;
        if (snap.matches('loaded')) {
          settled = true;
          if (snap.context.data) resolve(snap.context.data);
          else reject(new Error('thread data actor reached loaded state without data'));
          return;
        }
        if (snap.matches('failed')) {
          settled = true;
          reject(new Error(snap.context.error ?? 'failed to load thread data'));
          return;
        }
        if (snap.matches('unloaded')) {
          // Either we just started observing and need to kick off the fetch,
          // or an INVALIDATE just transitioned us back here mid-flight.
          if (reattempts >= LOAD_THREAD_MAX_REATTEMPTS) {
            settled = true;
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

      // Kick off the load. The subscribe callback above also fires on the
      // initial snapshot, so if the actor is already in `loaded` / `failed`,
      // resolution happens synchronously without ever hitting `unloaded`.
      actor.send({ type: 'LOAD' });
      return () => {
        settled = true;
        subscription.unsubscribe();
      };
    },
    {
      timeoutMs: LOAD_THREAD_TIMEOUT_MS,
      timeoutError: () =>
        new Error(`thread data actor for ${threadId} timed out after ${LOAD_THREAD_TIMEOUT_MS}ms`),
    },
  );
}
