/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ShutdownManager
 */

import {
  startSlidingWindowPrune,
  type SlidingWindowHits,
} from '@funny/shared/lib/sliding-window-hits';
import type { Context, Next } from 'hono';

import { shutdownManager, ShutdownPhase } from '../services/shutdown-manager.js';

const pruneTimers: ReturnType<typeof setInterval>[] = [];

// ── Self-register with ShutdownManager ──────────────────────
shutdownManager.register(
  'rate-limit-timer',
  () => {
    for (const timer of pruneTimers) {
      clearInterval(timer);
    }
    pruneTimers.length = 0;
  },
  ShutdownPhase.SERVICES,
);

/**
 * Simple in-memory sliding-window rate limiter.
 * Keyed by client IP. Tracks request timestamps and rejects with 429 when
 * the count within `windowMs` exceeds `max`.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const { windowMs, max } = opts;
  const hits: SlidingWindowHits = new Map();
  const pruneTimer = startSlidingWindowPrune(hits, windowMs);
  pruneTimers.push(pruneTimer);

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

// ── Tiered rate limit presets ────────────────────────────────

/** Default API rate limit: 5000 req/min */
export const defaultRateLimit = () => rateLimit({ windowMs: 60_000, max: 5000 });

/** Strict rate limit for auth endpoints: 20 req/min (prevents brute force) */
export const authRateLimit = () => rateLimit({ windowMs: 60_000, max: 20 });

/** Strict rate limit for mutation endpoints (create/delete): 200 req/min */
export const mutationRateLimit = () => rateLimit({ windowMs: 60_000, max: 200 });

/** Relaxed rate limit for read-heavy endpoints (WS, browse): 10000 req/min */
export const readRateLimit = () => rateLimit({ windowMs: 60_000, max: 10_000 });
