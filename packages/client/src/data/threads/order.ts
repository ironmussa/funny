import type { Thread } from '@funny/shared';

/**
 * Thread ordering shared with the server.
 *
 * Project lists come back sorted by `pinned DESC, COALESCE(completedAt,
 * createdAt) DESC` (`packages/shared/src/repositories/thread-repository.ts`).
 * Views that sort rows themselves (Kanban columns, new-row insertion) must
 * use the same comparator, or paging shows gaps and duplicates.
 */

function timeValue(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** `COALESCE(completedAt, createdAt)` as epoch ms. */
export function threadActivityTime(thread: Pick<Thread, 'completedAt' | 'createdAt'>): number {
  return timeValue(thread.completedAt || thread.createdAt);
}

/** Most recent activity first. Ties keep their input order (stable sort). */
function compareByActivityDesc(
  a: Pick<Thread, 'completedAt' | 'createdAt'>,
  b: Pick<Thread, 'completedAt' | 'createdAt'>,
): number {
  return threadActivityTime(b) - threadActivityTime(a);
}

/** Pinned first, then most recent activity first: the server's project-list order. */
export function compareThreadsForList(
  a: Pick<Thread, 'pinned' | 'completedAt' | 'createdAt'>,
  b: Pick<Thread, 'pinned' | 'completedAt' | 'createdAt'>,
): number {
  const pinned = Number(!!b.pinned) - Number(!!a.pinned);
  if (pinned !== 0) return pinned;
  return compareByActivityDesc(a, b);
}
