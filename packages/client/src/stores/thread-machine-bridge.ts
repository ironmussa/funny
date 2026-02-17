/**
 * Thread state machine bridge — manages xstate actors per thread.
 * Extracted from thread-store.ts for testability and separation of concerns.
 */

import { createActor } from 'xstate';
import { threadMachine, wsEventToMachineEvent, type ThreadContext } from '@/machines/thread-machine';
import type { ThreadStatus } from '@funny/shared';

export { wsEventToMachineEvent };

// ── Actor registry ──────────────────────────────────────────────

const threadActors = new Map<string, ReturnType<typeof createActor<typeof threadMachine>>>();

export function getThreadActor(threadId: string, initialStatus: ThreadStatus = 'pending', cost: number = 0) {
  let actor = threadActors.get(threadId);
  if (!actor) {
    actor = createActor(threadMachine, {
      input: { threadId, cost } as ThreadContext,
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
  cost: number = 0
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
}
