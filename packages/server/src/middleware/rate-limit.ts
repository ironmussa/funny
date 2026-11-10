/**
 * Simple in-memory sliding-window rate limiter for the server.
 *
 * Bucketing strategy (security H6):
 *   - Authenticated requests key on the userId first, and additionally on the
 *     caller IP when one is available. Sharing the IP bucket with all other
 *     anonymous callers would let one abuser lock every logged-in user out.
 *   - Anonymous requests key on IP only. `X-Forwarded-For` is trusted
 *     strictly when `TRUST_PROXY=true` is set in the environment — otherwise
 *     we rely on the socket remote address so a client cannot spoof its
 *     rate-limit bucket by attaching its own header.
 *   - If neither a userId nor a resolvable IP is present (e.g. a unix-socket
 *     transport), the request is allowed through: it is better to fail open
 *     than to merge every such request into a single shared `'unknown'`
 *     bucket, which is itself a denial-of-service vector.
 */

import {
  startSlidingWindowPrune,
  type SlidingWindowHits,
} from '@funny/shared/lib/sliding-window-hits';
import type { Context, Next } from 'hono';

import { clientIp } from '../lib/client-ip.js';
import { log } from '../lib/logger.js';

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

/** A sliding-window counter per key; `hit` records one request and says if it is over the limit. */
export function createSlidingWindowLimiter(opts: { windowMs: number; max: number }): {
  hit(key: string, now?: number): boolean;
} {
  const { windowMs, max } = opts;
  const hits: SlidingWindowHits = new Map();
  startSlidingWindowPrune(hits, windowMs);
  return {
    hit(key, now = Date.now()) {
      const valid = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (valid.length >= max) return true;
      valid.push(now);
      hits.set(key, valid);
      return false;
    },
  };
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  /** Also enforce a per-user limit (uses userId from context). Defaults to false. */
  perUser?: boolean;
  /** Requests this limiter does not count (they have a limiter of their own). */
  skip?: (c: Context) => boolean;
}) {
  const { windowMs, perUser, skip } = opts;
  const limiter = createSlidingWindowLimiter(opts);
  const check = (key: string, now: number): boolean => limiter.hit(key, now);

  return async (c: Context, next: Next) => {
    if (skip?.(c)) return next();
    const now = Date.now();
    const userId = c.get('userId') as string | undefined;
    const ip = clientIp(c);

    // Authenticated: userId is the primary bucket so a single abusive IP
    // cannot exhaust the limit for every legitimate user.
    if (userId) {
      if (check(`user:${userId}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
      // Apply an IP-scoped limit as a secondary defense when we can identify
      // the caller's IP. Only runs when `perUser` is enabled to match the
      // prior behaviour of the authenticated catch-all.
      if (perUser && ip && check(`ip:${ip}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
      return next();
    }

    // Anonymous: rate-limit on IP when we have one, otherwise allow through.
    // We explicitly refuse to fall back to a shared `'unknown'` bucket.
    if (ip) {
      if (check(`ip:${ip}`, now)) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: 'Too many requests' }, 429);
      }
    } else {
      log.debug('Rate limit skipped — no identifiable IP for anonymous request', {
        namespace: 'rate-limit',
        path: c.req.path,
        trustProxy: TRUST_PROXY,
      });
    }

    return next();
  };
}
