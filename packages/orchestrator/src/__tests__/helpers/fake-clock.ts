/**
 * A clock that moves only when the test says so. Sleepers wake once the
 * clock passes their deadline.
 */

import type { Clock } from '../../ports/clock.js';

export interface FakeClock extends Clock {
  /** Move time forward, waking every sleeper whose deadline has passed. */
  advance(ms: number): void;
}

export function fakeClock(start = '2026-11-10T12:00:00Z'): FakeClock {
  let now = Date.parse(start);
  let sleepers: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => new Date(now),
    sleep: (ms) => new Promise<void>((wake) => sleepers.push({ at: now + ms, wake })),
    advance(ms) {
      now += ms;
      const due = sleepers.filter((s) => s.at <= now);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due) s.wake();
    },
  };
}
