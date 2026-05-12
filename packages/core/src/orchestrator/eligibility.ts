/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: pure-logic
 * @domain layer: domain
 *
 * Eligibility predicates — given a `Thread` and the live in-memory
 * snapshot the orchestrator holds, decide whether the thread is
 * dispatchable right now. The companion SQL query in the service
 * layer pre-filters by stage/status; these predicates handle the
 * rest (claim dedup, retry queue, dependencies).
 */

import type { Thread } from '@funny/shared';

import type { EligibilityInput, SkippedReason } from './types.js';

export type EligibilityOutcome =
  | { eligible: true }
  | { eligible: false; reason: SkippedReason['reason'] };

/**
 * Decide eligibility for a single candidate. The slot policy is NOT
 * checked here — that lives in `plan-dispatch.ts` because it depends
 * on the running set of choices made earlier in the same tick.
 */
export function checkEligibility(thread: Thread, input: EligibilityInput): EligibilityOutcome {
  if (input.claimed.has(thread.id)) {
    return { eligible: false, reason: 'already-claimed' };
  }
  if (input.running.has(thread.id)) {
    return { eligible: false, reason: 'already-running' };
  }
  if (input.retryQueue.has(thread.id)) {
    return { eligible: false, reason: 'in-retry-queue' };
  }
  const blockers = input.dependencies.get(thread.id);
  if (blockers && blockers.length > 0) {
    for (const blocker of blockers) {
      if (!input.terminalThreadIds.has(blocker)) {
        return { eligible: false, reason: 'blocked-by-dependency' };
      }
    }
  }
  return { eligible: true };
}

/** Count how many of `running`'s entries belong to `userId`. */
export function countRunningForUser(
  running: Map<string, { userId: string }>,
  userId: string,
): number {
  let n = 0;
  for (const ref of running.values()) {
    if (ref.userId === userId) n++;
  }
  return n;
}
