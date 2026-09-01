import { useSyncExternalStore } from 'react';

/**
 * Global minute-level tick for relative timestamps.
 * A single lazy interval drives all subscribers — no per-component timers and
 * no background work while the UI has no relative timestamps mounted.
 */
const TICK_INTERVAL_MS = 60_000;
let now = Date.now();
let interval: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function publishTick() {
  now = Date.now();
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!interval) {
    // The module-level snapshot may be old after the last subscriber unmounted.
    // Refresh it synchronously; useSyncExternalStore reads it again after
    // subscribing and schedules the render when it changed.
    now = Date.now();
    interval = setInterval(publishTick, TICK_INTERVAL_MS);
  }

  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };
}

function getSnapshot() {
  return now;
}

/**
 * Returns the current shared clock value, refreshed every 60 seconds.
 * Any component calling this will re-render once per minute,
 * ensuring relative timestamps (timeAgo) stay fresh.
 */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
