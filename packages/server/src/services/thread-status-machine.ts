/**
 * Server-side thread state machine bridge.
 *
 * Manages XState actors per thread and provides a clean API
 * for transitioning thread status with resume-reason tracking.
 */

import { createActor } from 'xstate';
import {
  threadMachine,
  type ThreadEvent,
  type ThreadContext,
  type ResumeReason,
} from '@funny/shared/thread-machine';
import type { ThreadStatus } from '@funny/shared';

// ── Types ─────────────────────────────────────────────────────────

export interface TransitionResult {
  status: ThreadStatus;
  resumeReason: ResumeReason;
}

// ── Actor registry ────────────────────────────────────────────────

type ThreadActor = ReturnType<typeof createActor<typeof threadMachine>>;
const threadActors = new Map<string, ThreadActor>();

function getOrCreateActor(
  threadId: string,
  initialStatus: ThreadStatus = 'pending',
  cost: number = 0,
): ThreadActor {
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

// ── Public API ────────────────────────────────────────────────────

/**
 * Transition a thread's status via the state machine.
 * Returns the new status and the resumeReason context.
 */
export function transitionStatus(
  threadId: string,
  event: ThreadEvent,
  currentStatus: ThreadStatus,
  cost: number = 0,
): TransitionResult {
  const actor = getOrCreateActor(threadId, currentStatus, cost);
  actor.send(event);
  const snap = actor.getSnapshot();
  return {
    status: snap.value as ThreadStatus,
    resumeReason: snap.context.resumeReason,
  };
}

/**
 * Read the current resumeReason for a thread without transitioning.
 */
export function getResumeReason(threadId: string): ResumeReason {
  const actor = threadActors.get(threadId);
  if (!actor) return null;
  return actor.getSnapshot().context.resumeReason;
}

/**
 * Clean up the actor for a thread. Call on delete/archive.
 */
export function cleanupThreadActor(threadId: string): void {
  const actor = threadActors.get(threadId);
  if (actor) {
    actor.stop();
    threadActors.delete(threadId);
  }
}
