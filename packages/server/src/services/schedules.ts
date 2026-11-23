/**
 * Cron schedules, for whatever fires on one (automations, the factory's
 * schedule triggers): whether a pattern can run, and when it next occurs.
 *
 * Firing is the caller's: it takes each occurrence with a compare-and-set on
 * its row's stored next run time (`occurrenceTaken` says when a peer already
 * did), so several server processes start one run per occurrence.
 *
 * @domain subdomain: Scheduling
 * @domain type: domain-service
 * @domain layer: domain
 */

import { Cron } from 'croner';

/** Why `pattern` is not a schedule that can run, or null when it is. */
export function scheduleProblem(pattern: string): string | null {
  try {
    new Cron(pattern, { paused: true }).stop();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first occurrence of `pattern` after `from`, or null when there is none. */
export function nextOccurrence(pattern: string, from: Date): string | null {
  try {
    const cron = new Cron(pattern, { paused: true });
    const next = cron.nextRun(from);
    cron.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the occurrence a process just reached was already taken by a peer:
 * the stored next run time is the one this process would write (`next`), or a
 * later one. Both are ISO timestamps, or null when unknown: an unknown side
 * never counts as taken, the compare-and-set that follows decides.
 */
export function occurrenceTaken(stored: string | null, next: string | null): boolean {
  if (stored === null || next === null) return false;
  return Date.parse(stored) >= Date.parse(next);
}
