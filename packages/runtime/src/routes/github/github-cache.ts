import { log } from '../../lib/logger.js';

/**
 * In-memory, per-runner cache for GitHub REST responses.
 *
 * Three layers, all aimed at staying under GitHub's rate limits without any
 * external infrastructure:
 *
 *  1. **Fresh TTL** — within {@link FRESH_TTL_MS} of the last successful fetch,
 *     serve the cached body with NO network call at all. This collapses the
 *     burst of parallel + rapid-repeat polls (e.g. `pr-detail` fires 3-4 calls
 *     at once) that trip GitHub's *secondary* (anti-abuse / burst) rate limit.
 *  2. **Conditional request (ETag)** — after the TTL, re-validate with
 *     `If-None-Match`. A `304 Not Modified` does NOT count against the
 *     *primary* hourly limit, so steady-state polling is essentially free.
 *  3. **Cooldown** — when GitHub returns a rate-limit error (429, or a 403 that
 *     is rate-limit-shaped), honor its `Retry-After` / `X-RateLimit-Reset` and
 *     stop hitting GitHub until it elapses, serving stale cache meanwhile.
 *
 * Everything is keyed per token (so private-repo bodies never leak across
 * users) and the store is bounded by {@link MAX_ENTRIES} with oldest-first
 * eviction. State is lost on runner restart — acceptable for a polling cache.
 */

/** Serve cached without any network call within this window. */
export const FRESH_TTL_MS = 12_000;
/** Default cooldown when GitHub gives no Retry-After / reset hint. */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** Bound the store so a long-lived runner can't grow it without limit. */
const MAX_ENTRIES = 1_000;

interface CacheEntry {
  etag: string | null;
  link: string | null;
  bodyText: string;
  /** Last time this entry was confirmed current (200 or 304), in ms. */
  storedAt: number;
}

const store = new Map<string, CacheEntry>();
/** Per-token cooldown deadlines (ms epoch) set by a rate-limit response. */
const cooldownUntil = new Map<string, number>();

/** Cheap, non-cryptographic token fingerprint — never store the raw token as a key. */
function tokenKey(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function cacheKey(token: string, path: string, accept = ''): string {
  return `${tokenKey(token)}:${accept}:${path}`;
}

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  // Map preserves insertion order; drop the oldest ~10% in one pass.
  const toDrop = Math.ceil(MAX_ENTRIES * 0.1);
  let n = 0;
  for (const k of store.keys()) {
    store.delete(k);
    if (++n >= toDrop) break;
  }
}

export function getEntry(key: string): CacheEntry | undefined {
  return store.get(key);
}

export function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.storedAt < FRESH_TTL_MS;
}

export function setEntry(key: string, entry: CacheEntry): void {
  // Re-insert at the tail so eviction order tracks recency of writes.
  store.delete(key);
  store.set(key, entry);
  evictIfNeeded();
}

/** Mark a 304: the cached body is still current as of `now`. */
export function touchEntry(entry: CacheEntry, now: number): void {
  entry.storedAt = now;
}

export function inCooldown(token: string, now: number): boolean {
  const until = cooldownUntil.get(tokenKey(token));
  return until !== undefined && until > now;
}

export function cooldownRemainingSec(token: string, now: number): number {
  const until = cooldownUntil.get(tokenKey(token)) ?? now;
  return Math.max(1, Math.ceil((until - now) / 1000));
}

/**
 * Record a cooldown from a rate-limit {@link Response}. Prefers `Retry-After`
 * (seconds), then `X-RateLimit-Reset` (epoch seconds), else a fixed default.
 */
export function setCooldownFrom(token: string, res: Response, now: number): number {
  const retryAfter = res.headers.get('retry-after');
  const reset = res.headers.get('x-ratelimit-reset');
  let ms = DEFAULT_COOLDOWN_MS;
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    ms = Number(retryAfter.trim()) * 1000;
  } else if (reset && /^\d+$/.test(reset.trim())) {
    ms = Math.max(0, Number(reset.trim()) * 1000 - now);
  }
  // Clamp to something sane so a bogus header can't park us for hours.
  ms = Math.min(Math.max(ms, 1_000), 15 * 60_000);
  const until = now + ms;
  cooldownUntil.set(tokenKey(token), until);
  log.warn('github rate limit — entering cooldown', {
    namespace: 'github-cache',
    status: res.status,
    retryAfter,
    reset,
    cooldownMs: ms,
  });
  return until;
}

/**
 * A 429/403 is a *rate-limit* signal (vs. a real 403 forbidden) when GitHub
 * tells us to back off — either explicitly via `Retry-After` or by reporting
 * the primary bucket exhausted (`X-RateLimit-Remaining: 0`).
 */
export function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get('retry-after') != null || res.headers.get('x-ratelimit-remaining') === '0';
}

/** Build a `Response` from a cached entry that callers can consume normally. */
export function responseFromEntry(entry: CacheEntry): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (entry.etag) headers.set('ETag', entry.etag);
  if (entry.link) headers.set('Link', entry.link);
  headers.set('X-Funny-Cache', 'hit');
  return new Response(entry.bodyText, { status: 200, headers });
}

/** Test/diagnostic hook — drop all cached state. */
export function _resetGithubCache(): void {
  store.clear();
  cooldownUntil.clear();
}
