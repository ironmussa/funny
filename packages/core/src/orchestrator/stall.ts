/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: pure-logic
 * @domain layer: domain
 *
 * Stall detection. A run is "stalled" when no
 * progress event has arrived for longer than the configured timeout.
 * The orchestrator tick uses this to abort the underlying pipeline
 * and queue a retry.
 */

import type { RunRef } from './types.js';

/**
 * Returns true when the run has been silent for longer than
 * `stallTimeoutMs`.
 *
 * - `stallTimeoutMs <= 0` disables stall detection.
 * - Negative `now - lastEventAtMs` (clock skew) is treated as fresh.
 */
export function isStalled(run: RunRef, stallTimeoutMs: number, now: number): boolean {
  if (stallTimeoutMs <= 0) return false;
  const elapsed = now - run.lastEventAtMs;
  if (elapsed < 0) return false;
  return elapsed > stallTimeoutMs;
}
