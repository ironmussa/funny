/**
 * Bookkeeping shared by the in-memory sliding-window rate limiters of the
 * server and the runtime: request timestamps per bucket key.
 */

/** Request timestamps (ms) per rate-limit bucket key. */
export type SlidingWindowHits = Map<string, number[]>;

/** Drop timestamps older than `windowMs` from every key, deleting keys left empty. */
export function pruneSlidingWindowHits(
  hits: SlidingWindowHits,
  windowMs: number,
  now: number = Date.now(),
): void {
  for (const [key, timestamps] of hits) {
    const valid = timestamps.filter((t) => now - t < windowMs);
    if (valid.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, valid);
    }
  }
}

/**
 * Prune `hits` every `windowMs` to prevent memory growth. The timer is unref'd
 * so it never keeps the process alive; callers that own a shutdown hook may
 * still clear it.
 */
export function startSlidingWindowPrune(
  hits: SlidingWindowHits,
  windowMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => pruneSlidingWindowHits(hits, windowMs), windowMs);
  timer.unref();
  return timer;
}
