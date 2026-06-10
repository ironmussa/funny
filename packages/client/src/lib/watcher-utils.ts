import type { Job, Watcher, WatcherStatus } from '@funny/shared';

/**
 * Statuses that mean "a background process is being watched right now" — i.e.
 * a future wake is scheduled. Only `pending` qualifies: a `fired` watcher has
 * ALREADY woken the agent and is either about to be rescheduled (briefly) or
 * was concluded (historical) — it is NOT an active background process, so the
 * thread clock must not show for it. (Server-side `getLiveWatcherByThreadKey`
 * still treats `fired` as live so a reschedule re-arms the same row — that is a
 * separate concern from this UI notion of "active".)
 */
export const ACTIVE_WATCHER_STATUSES: WatcherStatus[] = ['pending'];

/** Human countdown to the next wake (e.g. "in 4m 12s" / "due"). */
export function formatCountdown(nextWakeAt: number, now: number): string {
  const ms = nextWakeAt - now;
  if (ms <= 0) return 'due';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `in ${m}m ${s}s` : `in ${s}s`;
}

/** Active (pending) watchers for one thread. */
export function selectActiveWatchersForThread(
  watchersById: Record<string, Watcher>,
  threadId: string,
): Watcher[] {
  const out: Watcher[] = [];
  for (const w of Object.values(watchersById)) {
    if (w.threadId === threadId && ACTIVE_WATCHER_STATUSES.includes(w.status)) out.push(w);
  }
  return out;
}

/** Running jobs for one thread — a running job is the most literal "background process". */
export function selectRunningJobsForThread(jobsById: Record<string, Job>, threadId: string): Job[] {
  const out: Job[] = [];
  for (const j of Object.values(jobsById)) {
    if (j.threadId === threadId && j.status === 'running') out.push(j);
  }
  return out;
}
