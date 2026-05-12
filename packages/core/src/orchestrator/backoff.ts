/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: pure-logic
 * @domain layer: domain
 *
 * Exponential backoff schedule for retried pipeline runs.
 * First retry quick, subsequent retries doubling, capped at `maxBackoffMs`.
 */

const FIRST_RETRY_DELAY_MS = 1_000;
const BASE_BACKOFF_MS = 10_000;

/**
 * Compute the delay (ms) before the next attempt.
 *
 * - `attempt <= 0`  → 1s (treats it as a continuation after a clean
 *                       cancellation; quick re-pickup, no penalty).
 * - `attempt === 1` → 10s
 * - `attempt === 2` → 20s
 * - `attempt === 3` → 40s
 * - … capped at `maxBackoffMs` (default 5 min).
 */
export function nextRetryDelayMs(attempt: number, maxBackoffMs = 300_000): number {
  if (!Number.isFinite(attempt)) return FIRST_RETRY_DELAY_MS;
  if (attempt <= 0) return FIRST_RETRY_DELAY_MS;
  const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(delay, maxBackoffMs);
}
