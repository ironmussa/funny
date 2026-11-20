/** Per-socket, per-event-type sliding-window rate limiter for Socket.IO message handlers. */

/**
 * Timestamps are tracked per socket and then per bucket (event type), so a burst
 * of one event type cannot exhaust the counter of another. Each socket maps to a
 * map of bucket name -> recent timestamps.
 */
const socketRateCounters = new Map<string, Map<string, number[]>>();

const DEFAULT_BUCKET = 'default';

/**
 * Check whether a socket has exceeded its message rate limit for a given bucket.
 * Each bucket (typically the event type) has its own sliding window, so events of
 * one type do not consume another type's budget.
 * Returns true if the message should be dropped.
 */
export function isRateLimited(
  socketId: string,
  maxPerWindow = 100,
  windowMs = 10_000,
  bucket: string = DEFAULT_BUCKET,
): boolean {
  const now = Date.now();
  let buckets = socketRateCounters.get(socketId);
  if (!buckets) {
    buckets = new Map();
    socketRateCounters.set(socketId, buckets);
  }
  const timestamps = buckets.get(bucket) ?? [];
  const valid = timestamps.filter((t) => now - t < windowMs);
  if (valid.length >= maxPerWindow) {
    buckets.set(bucket, valid);
    return true;
  }
  valid.push(now);
  buckets.set(bucket, valid);
  return false;
}

/** Remove all rate counters for a disconnected socket. */
export function clearSocketRate(socketId: string): void {
  socketRateCounters.delete(socketId);
}
