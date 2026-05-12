/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: pure-logic
 * @domain layer: domain
 *
 * Priority sort for eligible threads. Until a `priority` column is
 * added to threads, oldest-first by `createdAt` keeps the queue fair
 * and stable. `id` breaks ties so the order is fully deterministic.
 */

import type { Thread } from '@funny/shared';

export function compareThreadPriority(a: Thread, b: Thread): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Returns a new array sorted by priority — does not mutate input. */
export function sortByPriority(threads: Thread[]): Thread[] {
  return [...threads].sort(compareThreadPriority);
}
