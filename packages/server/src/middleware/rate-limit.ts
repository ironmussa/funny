import type { Context, Next } from 'hono';
import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';

let pruneTimer: ReturnType<typeof setInterval> | null = null;

// ── Self-register with ShutdownManager ──────────────────────
shutdownManager.register('rate-limit-timer', () => {
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}, ShutdownPhase.SERVICES);

/**
 * Simple in-memory sliding-window rate limiter.
 * Keyed by client IP. Tracks request timestamps and rejects with 429 when
 * the count within `windowMs` exceeds `max`.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const { windowMs, max } = opts;
  const hits = new Map<string, number[]>();

  // Clear previous timer if rateLimit is called again (hot reload)
  if (pruneTimer) clearInterval(pruneTimer);

  // Periodically prune stale entries to prevent memory growth
  pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, windowMs);
  pruneTimer.unref();

  return async (c: Context, next: Next) => {
    // Use Bun's socket address when available; only fall back to proxy
    // headers if a trusted proxy is explicitly configured.
    const socketAddr = (c.env as any)?.remoteAddress;
    const ip = socketAddr || 'unknown';

    const now = Date.now();
    const timestamps = hits.get(ip) ?? [];
    const valid = timestamps.filter((t) => now - t < windowMs);

    if (valid.length >= max) {
      c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }

    valid.push(now);
    hits.set(ip, valid);
    return next();
  };
}
