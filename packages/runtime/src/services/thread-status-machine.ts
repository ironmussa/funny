/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 * @domain aggregate: Thread
 *
 * Runner-side thread status transitions.
 *
 * The status stored on the thread row is the source of truth: every transition
 * is computed from the status the caller just read (`currentStatus`), never
 * from a status remembered here. The only thing kept in memory is the reason
 * the thread last entered `running`, which is not persisted and which a
 * `running` self-transition must carry over.
 */

import type { ThreadStatus } from '@funny/shared';
import {
  resolveThreadTransition,
  type ThreadEvent,
  type ResumeReason,
} from '@funny/shared/thread-machine';

// ── Types ─────────────────────────────────────────────────────────

export interface TransitionResult {
  status: ThreadStatus;
  resumeReason: ResumeReason;
}

// ── Resume reasons ────────────────────────────────────────────────

const resumeReasons = new Map<string, NonNullable<ResumeReason>>();

// ── Public API ────────────────────────────────────────────────────

/**
 * Transition a thread's status via the state machine, from `currentStatus`
 * (the status on the thread row). Returns the new status and the resume
 * reason; an event `currentStatus` does not accept leaves both unchanged.
 */
export function transitionStatus(
  threadId: string,
  event: ThreadEvent,
  currentStatus: ThreadStatus,
  cost: number = 0,
): TransitionResult {
  const { status, resumeReason } = resolveThreadTransition(currentStatus, event, {
    cost,
    resumeReason: resumeReasons.get(threadId) ?? null,
  });
  if (resumeReason) resumeReasons.set(threadId, resumeReason);
  else resumeReasons.delete(threadId);
  return { status, resumeReason };
}

/**
 * Read the current resumeReason for a thread without transitioning.
 */
export function getResumeReason(threadId: string): ResumeReason {
  return resumeReasons.get(threadId) ?? null;
}

/**
 * Forget what is remembered about a thread. Call on delete/archive.
 */
export function cleanupThreadActor(threadId: string): void {
  resumeReasons.delete(threadId);
}
