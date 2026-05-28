/** Per-socket sliding-window rate limiter for Socket.IO message handlers. */

const socketRateCounters = new Map<string, number[]>();

/**
 * Check whether a socket has exceeded its message rate limit.
 * Returns true if the message should be dropped.
 */
export function isRateLimited(socketId: string, maxPerWindow = 100, windowMs = 10_000): boolean {
  const now = Date.now();
  const timestamps = socketRateCounters.get(socketId) ?? [];
  const valid = timestamps.filter((t) => now - t < windowMs);
  if (valid.length >= maxPerWindow) return true;
  valid.push(now);
  socketRateCounters.set(socketId, valid);
  return false;
}

/** Remove rate counter for a disconnected socket. */
export function clearSocketRate(socketId: string): void {
  socketRateCounters.delete(socketId);
}
