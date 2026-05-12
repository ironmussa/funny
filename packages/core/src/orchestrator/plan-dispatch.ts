/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: pure-logic
 * @domain layer: domain
 *
 * Pure dispatch planner. Given a snapshot of the world, produce the
 * set of threads that should be claimed/retried this tick. The
 * service layer applies the plan (DB writes, dispatcher calls) — the
 * planner itself is deterministic and side-effect-free, which makes
 * the rules trivially testable.
 *
 * Returns `Result<DispatchPlan, OrchestratorError>` per CLAUDE.md's
 * neverthrow mandate for `packages/core`.
 */

import type { Thread } from '@funny/shared';
import { err, ok, type Result } from 'neverthrow';

import { checkEligibility, countRunningForUser } from './eligibility.js';
import { sortByPriority } from './priority.js';
import type {
  DispatchPlan,
  EligibilityInput,
  OrchestratorError,
  RetryEntry,
  SkippedReason,
} from './types.js';

export function planDispatch(input: EligibilityInput): Result<DispatchPlan, OrchestratorError> {
  const { slots, running, retryQueue, now } = input;
  if (slots.maxConcurrentGlobal < 0 || slots.maxConcurrentPerUser < 0) {
    return err({
      code: 'INVALID_INPUT',
      message: 'Slot caps must be non-negative',
    });
  }

  const skipped: SkippedReason[] = [];
  const toDispatch: Thread[] = [];
  const toRetry: RetryEntry[] = [];

  // Live counters — they grow as we accept dispatches/retries this
  // tick so subsequent picks see the updated state and respect caps.
  let globalRunning = running.size;
  const perUserRunning = new Map<string, number>();
  for (const ref of running.values()) {
    perUserRunning.set(ref.userId, (perUserRunning.get(ref.userId) ?? 0) + 1);
  }

  const remainingGlobal = () => slots.maxConcurrentGlobal - globalRunning;
  const remainingForUser = (userId: string) =>
    slots.maxConcurrentPerUser - (perUserRunning.get(userId) ?? 0);

  const accept = (userId: string): void => {
    globalRunning++;
    perUserRunning.set(userId, (perUserRunning.get(userId) ?? 0) + 1);
  };

  // ── Retries first: they were already in motion and have priority
  // over fresh dispatches once their backoff window elapses.
  const dueRetries = [...retryQueue.values()]
    .filter((entry) => entry.nextRetryAtMs <= now)
    .sort((a, b) => a.nextRetryAtMs - b.nextRetryAtMs);

  for (const entry of dueRetries) {
    if (remainingGlobal() <= 0) {
      skipped.push({ threadId: entry.threadId, reason: 'global-slots-exhausted' });
      continue;
    }
    if (remainingForUser(entry.userId) <= 0) {
      skipped.push({ threadId: entry.threadId, reason: 'user-slots-exhausted' });
      continue;
    }
    toRetry.push(entry);
    accept(entry.userId);
  }

  // ── Fresh dispatches: priority sort, then eligibility + slot caps.
  const ordered = sortByPriority(input.candidates);

  for (const thread of ordered) {
    const outcome = checkEligibility(thread, input);
    if (!outcome.eligible) {
      skipped.push({ threadId: thread.id, reason: outcome.reason });
      continue;
    }
    if (remainingGlobal() <= 0) {
      skipped.push({ threadId: thread.id, reason: 'global-slots-exhausted' });
      continue;
    }
    if (remainingForUser(thread.userId) <= 0) {
      skipped.push({ threadId: thread.id, reason: 'user-slots-exhausted' });
      continue;
    }
    toDispatch.push(thread);
    accept(thread.userId);
  }

  return ok({ toDispatch, toRetry, skipped });
}

// Re-exported for the service layer to count without needing
// `eligibility.ts` directly.
export { countRunningForUser };
